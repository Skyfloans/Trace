import process from "node:process";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
let runs = 0;
let proposals = 0;

try {
  await client.connect();
  await client.query("BEGIN");
  const candidates = await client.query(`
    SELECT run.id, run.project_id,
           15 - (
             SELECT COUNT(*)::int
             FROM roblox_autofix_proposals outstanding
             WHERE outstanding.project_id = run.project_id
               AND outstanding.status IN (
                 'queued', 'processing', 'ready', 'conflict'
               )
           ) AS available
    FROM roblox_autofix_runs run
    WHERE run.status = 'failed'
      AND run.last_error LIKE 'Invalid LZ4%'
      AND run.id = (
        SELECT oldest.id
        FROM roblox_autofix_runs oldest
        WHERE oldest.project_id = run.project_id
          AND oldest.status = 'failed'
          AND oldest.last_error LIKE 'Invalid LZ4%'
        ORDER BY oldest.created_at, oldest.id
        LIMIT 1
      )
    FOR UPDATE OF run SKIP LOCKED
  `);

  for (const candidate of candidates.rows) {
    const available = Math.max(0, Number(candidate.available));
    if (available === 0) continue;
    const reset = await client.query(
      `WITH selected AS (
         SELECT id
         FROM roblox_autofix_proposals
         WHERE run_id = $1
           AND status = 'failed'
           AND failure_reason LIKE 'Invalid LZ4%'
         ORDER BY priority_rank, created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE roblox_autofix_proposals proposal
       SET status = 'queued',
           failure_reason = NULL,
           updated_at = now()
       FROM selected
       WHERE proposal.id = selected.id
       RETURNING proposal.id`,
      [candidate.id, available],
    );
    if (reset.rowCount === 0) continue;
    await client.query(
      `UPDATE roblox_autofix_runs
       SET status = 'queued',
           input_tokens = 0,
           output_tokens = 0,
           started_at = NULL,
           finished_at = NULL,
           last_error = NULL
       WHERE id = $1`,
      [candidate.id],
    );
    runs += 1;
    proposals += reset.rowCount ?? 0;
  }

  await client.query("COMMIT");
  console.log(JSON.stringify({
    retry: "roblox_zstd_autofix",
    runs,
    proposals,
  }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
