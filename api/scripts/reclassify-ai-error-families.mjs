import pg from "pg";

const promptVersion = Number(process.env.AI_ERROR_PROMPT_VERSION ?? 3);
const batchSize = Math.max(
  100,
  Math.min(
    Number(process.env.AI_ERROR_RECLASSIFY_BATCH_SIZE ?? 5_000),
    20_000,
  ),
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let keyedGroups = 0;
let queuedFamilies = 0;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '5min'");

  let groupCursor = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const keyed = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT id
         FROM display_error_groups
         WHERE id > $1::uuid
           AND ai_family_key IS NULL
           AND level IN ('error', 'warning')
         ORDER BY id
         LIMIT $2
       )
       UPDATE display_error_groups groups
       SET ai_family_key = ai_error_family_key(
             groups.source::text,
             groups.level::text,
             groups.normalized_message
           )
       FROM candidates
       WHERE groups.id = candidates.id
       RETURNING groups.id`,
      [groupCursor, batchSize],
    );
    const count = keyed.rowCount ?? 0;
    keyedGroups += count;
    if (count > 0) {
      groupCursor = String(
        keyed.rows.reduce(
          (maximum, row) => (
              String(row.id).localeCompare(maximum) > 0
                ? String(row.id)
                : maximum
            ),
          groupCursor,
        ),
      );
    }
    console.log(JSON.stringify({
      phase: "family_keys",
      count,
      keyedGroups,
      cursor: groupCursor,
    }));
    if (count < batchSize) break;
  }

  const demoted = await client.query(
    `UPDATE ai_classification_jobs
     SET status = 'pending',
         priority = 1,
         available_at = LEAST(available_at, now()),
         locked_at = NULL,
         locked_by = NULL
     WHERE target_type = 'error'
       AND (
         priority >= 10
         OR status = 'processing'
       )`,
  );

  let cursor = "";
  while (true) {
    const candidates = await client.query(
      `SELECT DISTINCT ON (groups.ai_family_key)
         groups.ai_family_key,
         groups.id,
         groups.project_id
       FROM display_error_groups groups
       LEFT JOIN ai_error_family_classifications cached
         ON cached.family_key = groups.ai_family_key
       WHERE groups.ai_family_key IS NOT NULL
         AND groups.ai_family_key > $1
         AND groups.level IN ('error', 'warning')
         AND COALESCE(cached.prompt_version, 0) < $2
       ORDER BY
         groups.ai_family_key,
         groups.last_seen_at DESC,
         groups.id
       LIMIT $3`,
      [cursor, promptVersion, batchSize],
    );
    if (candidates.rows.length === 0) break;

    const ids = candidates.rows.map((row) => String(row.id));
    const projectIds = candidates.rows.map((row) => String(row.project_id));
    for (let attempt = 1; ; attempt += 1) {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE display_error_groups
           SET ai_status = 'pending'
           WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        await client.query(
          `INSERT INTO ai_classification_jobs (
             target_type,
             target_id,
             project_id,
             status,
             priority,
             attempts,
             available_at,
             locked_at,
             locked_by,
             last_error
           )
           SELECT
             'error'::ai_classification_target,
             input.id,
             input.project_id,
             'pending',
             10,
             0,
             now(),
             NULL,
             NULL,
             NULL
           FROM unnest(
             $1::uuid[],
             $2::uuid[]
           ) AS input(id, project_id)
           ON CONFLICT (target_type, target_id) DO UPDATE
           SET project_id = EXCLUDED.project_id,
               status = 'pending',
               priority = 10,
               attempts = 0,
               available_at = now(),
               locked_at = NULL,
               locked_by = NULL,
               last_error = NULL`,
          [ids, projectIds],
        );
        await client.query("COMMIT");
        break;
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          !["40P01", "55P03"].includes(error?.code) ||
          attempt >= 12
        ) {
          throw error;
        }
        await wait(Math.min(5_000, attempt * 500));
      }
    }

    queuedFamilies += candidates.rows.length;
    cursor = String(candidates.rows.at(-1).ai_family_key);
    console.log(JSON.stringify({
      phase: "queue",
      count: candidates.rows.length,
      queuedFamilies,
      cursor,
      promptVersion,
    }));
  }

  const status = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE target_type = 'error'
           AND priority >= 10
       )::bigint AS ready_families,
       COUNT(*) FILTER (
         WHERE target_type = 'error'
           AND priority < 10
       )::bigint AS dormant_members
     FROM ai_classification_jobs`,
  );
  console.log(JSON.stringify({
    phase: "complete",
    promptVersion,
    keyedGroups,
    demotedJobs: demoted.rowCount ?? 0,
    queuedFamilies,
    ...status.rows[0],
  }));
} finally {
  await client.end();
}
