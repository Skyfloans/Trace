import pg from "pg";

const batchSize = Number(process.env.DISPLAY_FILTER_BACKFILL_BATCH_SIZE ?? 5_000);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query("BEGIN READ ONLY");
  await client.query(`
    DECLARE display_filter_targets NO SCROLL CURSOR WITH HOLD FOR
    SELECT
      rollups.project_id,
      rollups.display_group_id,
      rollups.bucket_at,
      groups.level,
      groups.source
    FROM display_error_rollups_hourly rollups
    JOIN display_error_groups groups ON groups.id = rollups.display_group_id
    WHERE ROW(rollups.level, rollups.source)
      IS DISTINCT FROM ROW(groups.level, groups.source)
    ORDER BY rollups.project_id, rollups.display_group_id, rollups.bucket_at
  `);
  await client.query("COMMIT");

  let updatedTotal = 0;
  for (;;) {
    const targets = await client.query(
      `FETCH FORWARD ${batchSize} FROM display_filter_targets`,
    );
    if (targets.rows.length === 0) break;
    const updated = await client.query(`
      UPDATE display_error_rollups_hourly rollups
      SET level = target.level::log_level,
          source = target.source::log_source
      FROM jsonb_to_recordset($1::jsonb) AS target(
        project_id uuid,
        display_group_id uuid,
        bucket_at timestamptz,
        level text,
        source text
      )
      WHERE rollups.project_id = target.project_id
        AND rollups.display_group_id = target.display_group_id
        AND rollups.bucket_at = target.bucket_at
    `, [JSON.stringify(targets.rows)]);
    updatedTotal += Number(updated.rowCount ?? 0);
    console.log(JSON.stringify({ updated: updated.rowCount, updatedTotal }));
  }
  await client.query("CLOSE display_filter_targets");

  const verification = await client.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE ROW(rollups.level, rollups.source)
          IS DISTINCT FROM ROW(groups.level, groups.source)
      )::bigint AS mismatched_rollups,
      to_regclass('public.display_error_rollups_filter_idx') IS NOT NULL
        AS index_ready
    FROM display_error_rollups_hourly rollups
    JOIN display_error_groups groups ON groups.id = rollups.display_group_id
  `);
  const totals = verification.rows[0];
  if (String(totals.mismatched_rollups) !== "0") {
    throw new Error(`Display rollup filter verification failed: ${JSON.stringify(totals)}`);
  }

  if (totals.index_ready === true) {
    await client.query(`
      INSERT INTO trace_read_model_state (key)
      VALUES ('display_error_rollup_filters_v1')
      ON CONFLICT (key) DO UPDATE SET ready_at = now()
    `);
  }
  console.log(JSON.stringify({
    ready: totals.index_ready === true,
    updatedTotal,
    ...totals,
  }));
} finally {
  await client.end();
}
