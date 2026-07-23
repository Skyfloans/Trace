import pg from "pg";

const requestedBatchSize = Number(process.env.DISPLAY_BACKFILL_BATCH_SIZE ?? 5_000);
const validateOnly = process.env.DISPLAY_BACKFILL_VALIDATE_ONLY === "1";
const batchSize = validateOnly ? Math.min(requestedBatchSize, 100) : requestedBatchSize;
const rollupBatchSize = Number(process.env.DISPLAY_BACKFILL_ROLLUP_BATCH_SIZE ?? 250);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (validateOnly) await client.query("BEGIN");

  let processedTotal = 0;
  let afterId = process.env.DISPLAY_BACKFILL_AFTER_ID
    ?? "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const result = await client.query(`
      WITH candidates AS (
        SELECT
          id,
          project_id,
          fingerprint,
          source,
          level,
          source_script,
          normalized_message,
          display_fingerprint,
          display_message,
          display_source_script,
          first_seen_at,
          last_seen_at
        FROM error_groups
        WHERE id > $2::uuid
        ORDER BY id
        LIMIT $1
      ), display_values AS (
        SELECT
          candidates.*,
          CASE
            WHEN COALESCE(display_message, normalized_message)
              ~* '^Data loaded for player [A-Za-z0-9_]{3,20}$'
            THEN regexp_replace(
              COALESCE(display_message, normalized_message),
              '[A-Za-z0-9_]{3,20}$',
              '<PLAYER_NAME>',
              'i'
            )
            ELSE COALESCE(display_message, normalized_message)
          END AS effective_message,
          COALESCE(display_source_script, source_script) AS effective_source_script
        FROM candidates
      ), identities AS (
        SELECT
          display_values.*,
          encode(digest(
            convert_to(source::text, 'UTF8') || decode('00', 'hex') ||
            convert_to(level::text, 'UTF8') || decode('00', 'hex') ||
            convert_to(COALESCE(effective_source_script, ''), 'UTF8') || decode('00', 'hex') ||
            convert_to(effective_message, 'UTF8'),
            'sha256'
          ), 'hex') AS effective_fingerprint
        FROM display_values
      ), display_input AS (
        SELECT
          project_id,
          effective_fingerprint AS fingerprint,
          level,
          source,
          effective_message AS normalized_message,
          effective_source_script AS source_script,
          MIN(first_seen_at) AS first_seen_at,
          MAX(last_seen_at) AS last_seen_at
        FROM identities
        GROUP BY
          project_id,
          effective_fingerprint,
          level,
          source,
          effective_message,
          effective_source_script
      ), upserted AS (
        INSERT INTO display_error_groups (
          project_id, fingerprint, level, source, normalized_message,
          source_script, first_seen_at, last_seen_at
        )
        SELECT
          project_id, fingerprint, level, source, normalized_message,
          source_script, first_seen_at, last_seen_at
        FROM display_input
        ORDER BY project_id, fingerprint
        ON CONFLICT (project_id, fingerprint) DO UPDATE
        SET first_seen_at = LEAST(
              display_error_groups.first_seen_at,
              EXCLUDED.first_seen_at
            ),
            last_seen_at = GREATEST(
              display_error_groups.last_seen_at,
              EXCLUDED.last_seen_at
            ),
            source_script = COALESCE(
              display_error_groups.source_script,
              EXCLUDED.source_script
            )
        RETURNING id, project_id, fingerprint
      ), resolved AS (
        SELECT id, project_id, fingerprint FROM upserted
        UNION
        SELECT groups.id, groups.project_id, groups.fingerprint
        FROM display_error_groups groups
        JOIN display_input
          ON display_input.project_id = groups.project_id
         AND display_input.fingerprint = groups.fingerprint
      ), members AS (
        INSERT INTO display_error_group_members (
          exact_group_id,
          display_group_id
        )
        SELECT identities.id, resolved.id
        FROM identities
        JOIN resolved
          ON resolved.project_id = identities.project_id
         AND resolved.fingerprint = identities.effective_fingerprint
        ON CONFLICT (exact_group_id) DO UPDATE
        SET display_group_id = EXCLUDED.display_group_id
        RETURNING exact_group_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM candidates) AS processed,
        (SELECT id::text FROM candidates ORDER BY id DESC LIMIT 1) AS after_id,
        (SELECT COUNT(*)::int FROM members) AS mapped
    `, [batchSize, afterId]);

    const processed = Number(result.rows[0]?.processed ?? 0);
    const mapped = Number(result.rows[0]?.mapped ?? 0);
    processedTotal += processed;
    if (result.rows[0]?.after_id) afterId = String(result.rows[0].after_id);
    console.log(JSON.stringify({ processed, mapped, processedTotal, afterId }));
    if (validateOnly || processed < batchSize) break;
  }

  if (validateOnly) {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ validated: true, rolledBack: true, batchSize }));
  } else {
    await client.query("BEGIN READ ONLY");
    await client.query(`
      DECLARE display_rollup_targets NO SCROLL CURSOR WITH HOLD FOR
      SELECT DISTINCT
        source.project_id,
        source.bucket_at,
        members.display_group_id,
        groups.fingerprint
      FROM occurrence_rollups_hourly source
      JOIN display_error_group_members members
        ON members.exact_group_id = source.group_id
      JOIN display_error_groups groups
        ON groups.id = members.display_group_id
      ORDER BY source.project_id, source.bucket_at, members.display_group_id
    `);
    await client.query("COMMIT");

    let rebuiltPairs = 0;
    for (;;) {
      const targets = await client.query(
        `FETCH FORWARD ${rollupBatchSize} FROM display_rollup_targets`,
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
              to_char(
                target.bucket_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24'
              ) || ':' || target.fingerprint,
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
            first_seen_at, last_seen_at
          )
          SELECT
            source.project_id,
            members.display_group_id,
            source.bucket_at,
            SUM(source.event_count)::bigint,
            MIN(source.first_seen_at),
            MAX(source.last_seen_at)
          FROM targets
          JOIN display_error_group_members members
            ON members.display_group_id = targets.display_group_id
          JOIN occurrence_rollups_hourly source
            ON source.group_id = members.exact_group_id
           AND source.project_id = targets.project_id
           AND source.bucket_at = targets.bucket_at
          GROUP BY source.project_id, members.display_group_id, source.bucket_at
        `, [targetJson]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      rebuiltPairs += targets.rows.length;
      console.log(JSON.stringify({
        rebuiltPairs,
        batchPairs: targets.rows.length,
      }));
    }
    await client.query("CLOSE display_rollup_targets");

    const verification = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM error_groups groups
       WHERE NOT EXISTS (
         SELECT 1 FROM display_error_group_members members
         WHERE members.exact_group_id = groups.id
       ))::bigint AS missing_members,
      (SELECT COALESCE(SUM(event_count), 0)
       FROM occurrence_rollups_hourly)::bigint AS exact_event_count,
      (SELECT COALESCE(SUM(event_count), 0)
       FROM display_error_rollups_hourly)::bigint AS display_event_count
    `);
    const totals = verification.rows[0];
    if (
      String(totals.missing_members) !== "0"
      || String(totals.exact_event_count) !== String(totals.display_event_count)
    ) {
      throw new Error(`Display read model verification failed: ${JSON.stringify(totals)}`);
    }

    await client.query(`
    INSERT INTO trace_read_model_state (key)
    VALUES ('display_error_read_model_v1')
    ON CONFLICT (key) DO UPDATE SET ready_at = now()
    `);
    console.log(JSON.stringify({ ready: true, ...totals }));
  }
} finally {
  await client.end();
}
