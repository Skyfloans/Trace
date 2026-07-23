import pg from "pg";

const batchSize = Number(process.env.DISPLAY_RECONCILE_BATCH_SIZE ?? 250);
const maxPasses = Number(process.env.DISPLAY_RECONCILE_MAX_PASSES ?? 3);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function verify() {
  const result = await client.query(`
    WITH expected AS (
      SELECT
        source.project_id,
        members.display_group_id,
        source.bucket_at,
        SUM(source.event_count)::bigint AS event_count,
        MIN(source.first_seen_at) AS first_seen_at,
        MAX(source.last_seen_at) AS last_seen_at
      FROM occurrence_rollups_hourly source
      JOIN display_error_group_members members
        ON members.exact_group_id = source.group_id
      GROUP BY source.project_id, members.display_group_id, source.bucket_at
    ), mismatches AS (
      SELECT 1
      FROM expected
      FULL JOIN display_error_rollups_hourly actual
        ON actual.project_id = expected.project_id
       AND actual.display_group_id = expected.display_group_id
       AND actual.bucket_at = expected.bucket_at
      WHERE expected.project_id IS NULL
         OR actual.project_id IS NULL
         OR ROW(expected.event_count, expected.first_seen_at, expected.last_seen_at)
            IS DISTINCT FROM
            ROW(actual.event_count, actual.first_seen_at, actual.last_seen_at)
    )
    SELECT
      (SELECT COUNT(*) FROM error_groups groups
       WHERE NOT EXISTS (
         SELECT 1 FROM display_error_group_members members
         WHERE members.exact_group_id = groups.id
       ))::bigint AS missing_members,
      (SELECT COALESCE(SUM(event_count), 0)
       FROM occurrence_rollups_hourly)::bigint AS exact_event_count,
      (SELECT COALESCE(SUM(event_count), 0)
       FROM display_error_rollups_hourly)::bigint AS display_event_count,
      (SELECT COUNT(*) FROM mismatches)::bigint AS mismatched_rollups
  `);
  return result.rows[0];
}

try {
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const cursorName = `display_rollup_reconcile_${pass}`;
    await client.query("BEGIN READ ONLY");
    await client.query(`
      DECLARE ${cursorName} NO SCROLL CURSOR WITH HOLD FOR
      WITH expected AS (
        SELECT
          source.project_id,
          members.display_group_id,
          source.bucket_at,
          SUM(source.event_count)::bigint AS event_count,
          MIN(source.first_seen_at) AS first_seen_at,
          MAX(source.last_seen_at) AS last_seen_at
        FROM occurrence_rollups_hourly source
        JOIN display_error_group_members members
          ON members.exact_group_id = source.group_id
        GROUP BY source.project_id, members.display_group_id, source.bucket_at
      )
      SELECT
        COALESCE(expected.project_id, actual.project_id) AS project_id,
        COALESCE(expected.bucket_at, actual.bucket_at) AS bucket_at,
        COALESCE(expected.display_group_id, actual.display_group_id) AS display_group_id,
        groups.fingerprint
      FROM expected
      FULL JOIN display_error_rollups_hourly actual
        ON actual.project_id = expected.project_id
       AND actual.display_group_id = expected.display_group_id
       AND actual.bucket_at = expected.bucket_at
      JOIN display_error_groups groups
        ON groups.id = COALESCE(expected.display_group_id, actual.display_group_id)
      WHERE expected.project_id IS NULL
         OR actual.project_id IS NULL
         OR ROW(expected.event_count, expected.first_seen_at, expected.last_seen_at)
            IS DISTINCT FROM
            ROW(actual.event_count, actual.first_seen_at, actual.last_seen_at)
      ORDER BY 1, 2, 3
    `);
    await client.query("COMMIT");

    let repaired = 0;
    for (;;) {
      const targets = await client.query(
        `FETCH FORWARD ${batchSize} FROM ${cursorName}`,
      );
      if (targets.rows.length === 0) break;
      const targetJson = JSON.stringify(targets.rows);

      await client.query("BEGIN");
      try {
        await client.query(`
          SELECT pg_advisory_xact_lock(locks.lock_key)
          FROM (
            SELECT hashtextextended(
              'display-rollup:' || target.project_id::text || ':' ||
              to_char(target.bucket_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24') ||
              ':' || target.fingerprint,
              0
            ) AS lock_key
            FROM jsonb_to_recordset($1::jsonb) AS target(
              project_id uuid,
              bucket_at timestamptz,
              display_group_id uuid,
              fingerprint text
            )
          ) locks
          ORDER BY locks.lock_key
        `, [targetJson]);
        await client.query(`
          DELETE FROM display_error_rollups_hourly rollups
          USING jsonb_to_recordset($1::jsonb) AS target(
            project_id uuid,
            bucket_at timestamptz,
            display_group_id uuid,
            fingerprint text
          )
          WHERE rollups.project_id = target.project_id
            AND rollups.bucket_at = target.bucket_at
            AND rollups.display_group_id = target.display_group_id
        `, [targetJson]);
        await client.query(`
          WITH targets AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS target(
              project_id uuid,
              bucket_at timestamptz,
              display_group_id uuid,
              fingerprint text
            )
          )
          INSERT INTO display_error_rollups_hourly (
            project_id, display_group_id, bucket_at, event_count,
            first_seen_at, last_seen_at, level, source
          )
          SELECT
            source.project_id,
            members.display_group_id,
            source.bucket_at,
            SUM(source.event_count)::bigint,
            MIN(source.first_seen_at),
            MAX(source.last_seen_at),
            groups.level,
            groups.source
          FROM targets
          JOIN display_error_group_members members
            ON members.display_group_id = targets.display_group_id
          JOIN display_error_groups groups
            ON groups.id = members.display_group_id
          JOIN occurrence_rollups_hourly source
            ON source.group_id = members.exact_group_id
           AND source.project_id = targets.project_id
           AND source.bucket_at = targets.bucket_at
          GROUP BY
            source.project_id,
            members.display_group_id,
            source.bucket_at,
            groups.level,
            groups.source
        `, [targetJson]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      repaired += targets.rows.length;
    }
    await client.query(`CLOSE ${cursorName}`);

    const totals = await verify();
    console.log(JSON.stringify({ pass, repaired, ...totals }));
    if (
      String(totals.missing_members) === "0"
      && String(totals.exact_event_count) === String(totals.display_event_count)
      && String(totals.mismatched_rollups) === "0"
    ) {
      await client.query(`
        INSERT INTO trace_read_model_state (key)
        VALUES ('display_error_read_model_v1')
        ON CONFLICT (key) DO UPDATE SET ready_at = now()
      `);
      console.log(JSON.stringify({ ready: true, ...totals }));
      process.exitCode = 0;
      break;
    }

    if (pass === maxPasses) {
      throw new Error(`Display read model reconciliation failed: ${JSON.stringify(totals)}`);
    }
  }
} finally {
  await client.end();
}
