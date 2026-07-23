import pg from "pg";

const batchSize = Number(process.env.AI_CLASSIFICATION_ENQUEUE_BATCH_SIZE ?? 10_000);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function enqueue(targetType, table, timeColumn, extraCondition = "TRUE") {
  let total = 0;
  let cursorTime = null;
  let cursorId = null;
  while (true) {
    const candidates = await client.query(`
      SELECT target.id, target.project_id, target.${timeColumn} AS sort_at
      FROM ${table} target
      WHERE target.ai_status = 'pending'
        AND ${extraCondition}
        AND (
          $1::timestamptz IS NULL
          OR (target.${timeColumn}, target.id) < ($1, $2)
        )
      ORDER BY target.${timeColumn} DESC, target.id DESC
      LIMIT $3
    `, [cursorTime, cursorId, batchSize]);
    if (candidates.rows.length === 0) break;
    const result = await client.query(`
      INSERT INTO ai_classification_jobs (
        target_type,
        target_id,
        project_id
      )
      SELECT
        $1::ai_classification_target,
        input.id,
        input.project_id
      FROM unnest($2::uuid[], $3::uuid[]) AS input(id, project_id)
      ON CONFLICT (target_type, target_id) DO NOTHING
    `, [
      targetType,
      candidates.rows.map((row) => row.id),
      candidates.rows.map((row) => row.project_id),
    ]);
    const inserted = result.rowCount ?? 0;
    total += inserted;
    console.log(JSON.stringify({ targetType, inserted, total }));
    const last = candidates.rows.at(-1);
    cursorTime = last.sort_at;
    cursorId = last.id;
  }
}

try {
  await enqueue(
    "error",
    "display_error_groups",
    "last_seen_at",
    "target.last_seen_at >= now() - interval '3 days'",
  );
  await enqueue("feedback", "feedback", "submitted_at");
} finally {
  await client.end();
}
