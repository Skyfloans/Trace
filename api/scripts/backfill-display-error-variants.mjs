import pg from "pg";

const batchHours = Number(process.env.DISPLAY_VARIANT_BATCH_HOURS ?? 1);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const bounds = await client.query(`
    SELECT
      GREATEST(
        date_trunc('hour', COALESCE(MIN(occurred_at), now())),
        date_trunc('hour', now() - interval '3 days')
      ) AS first_bucket,
      now() AS finished_at
    FROM occurrences
    WHERE occurred_at >= now() - interval '3 days'
  `);
  let cursor = new Date(bounds.rows[0].first_bucket);
  const finishedAt = new Date(bounds.rows[0].finished_at);

  while (cursor < finishedAt) {
    const next = new Date(Math.min(
      cursor.getTime() + batchHours * 60 * 60 * 1_000,
      finishedAt.getTime(),
    ));
    const result = await client.query(`
      INSERT INTO display_error_variants_hourly (
        project_id, display_group_id, bucket_at, message_hash, message,
        event_count, first_seen_at, last_seen_at
      )
      SELECT
        occurrences.project_id,
        occurrences.display_group_id,
        date_trunc(
          'hour',
          occurrences.occurred_at AT TIME ZONE 'UTC'
        ) AT TIME ZONE 'UTC',
        digest(
          COALESCE(occurrences.original_message, groups.normalized_message),
          'sha256'
        ),
        COALESCE(occurrences.original_message, groups.normalized_message),
        SUM(occurrences.repeat_count)::bigint,
        MIN(occurrences.occurred_at),
        MAX(COALESCE(
          occurrences.last_occurred_at,
          occurrences.occurred_at
        ))
      FROM occurrences
      JOIN error_groups groups ON groups.id = occurrences.group_id
      WHERE occurrences.occurred_at >= $1
        AND occurrences.occurred_at < $2
        AND occurrences.display_group_id IS NOT NULL
      GROUP BY
        occurrences.project_id,
        occurrences.display_group_id,
        3,
        4,
        5
      ON CONFLICT (
        project_id, display_group_id, bucket_at, message_hash
      ) DO UPDATE
      SET event_count = GREATEST(
            display_error_variants_hourly.event_count,
            EXCLUDED.event_count
          ),
          message = EXCLUDED.message,
          first_seen_at = LEAST(
            display_error_variants_hourly.first_seen_at,
            EXCLUDED.first_seen_at
          ),
          last_seen_at = GREATEST(
            display_error_variants_hourly.last_seen_at,
            EXCLUDED.last_seen_at
          )
    `, [cursor, next]);
    console.log(JSON.stringify({
      from: cursor.toISOString(),
      to: next.toISOString(),
      rows: result.rowCount ?? 0,
    }));
    cursor = next;
  }

  const verification = await client.query(`
    WITH expected AS (
      SELECT
        occurrences.project_id,
        occurrences.display_group_id,
        date_trunc(
          'hour',
          occurrences.occurred_at AT TIME ZONE 'UTC'
        ) AT TIME ZONE 'UTC' AS bucket_at,
        digest(
          COALESCE(occurrences.original_message, groups.normalized_message),
          'sha256'
        ) AS message_hash,
        SUM(occurrences.repeat_count)::bigint AS event_count
      FROM occurrences
      JOIN error_groups groups ON groups.id = occurrences.group_id
      WHERE occurrences.occurred_at >= $1
        AND occurrences.occurred_at < $2
        AND occurrences.display_group_id IS NOT NULL
      GROUP BY 1, 2, 3, 4
    ), actual AS (
      SELECT
        project_id,
        display_group_id,
        bucket_at,
        message_hash,
        event_count
      FROM display_error_variants_hourly
      WHERE bucket_at >= date_trunc('hour', $1::timestamptz)
        AND bucket_at <= date_trunc('hour', $2::timestamptz)
    )
    SELECT COUNT(*)::bigint AS mismatched
    FROM expected
    LEFT JOIN actual USING (
      project_id,
      display_group_id,
      bucket_at,
      message_hash
    )
    WHERE actual.event_count IS NULL
       OR actual.event_count < expected.event_count
  `, [new Date(bounds.rows[0].first_bucket), finishedAt]);
  if (String(verification.rows[0].mismatched) !== "0") {
    throw new Error(
      `Display variant verification failed: ${JSON.stringify(verification.rows[0])}`,
    );
  }

  await client.query(`
    INSERT INTO trace_read_model_state (key)
    VALUES ('display_error_variants_v1')
    ON CONFLICT (key) DO UPDATE SET ready_at = now()
  `);
  console.log(JSON.stringify({ ready: true, ...verification.rows[0] }));
} finally {
  await client.end();
}
