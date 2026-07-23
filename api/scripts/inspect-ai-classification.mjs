import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query("SET statement_timeout = '10s'");
  const queue = await client.query(`
      SELECT
        target_type,
        status,
        COUNT(*)::bigint AS jobs,
        MAX(attempts)::int AS max_attempts,
        MAX(last_error) FILTER (WHERE last_error IS NOT NULL) AS sample_error
      FROM ai_classification_jobs
      GROUP BY target_type, status
      ORDER BY target_type, status
    `);
  const errors = await client.query(`
      SELECT ai_status, ai_category, COUNT(*)::bigint AS groups
      FROM display_error_groups
      WHERE last_seen_at >= now() - interval '3 days'
        AND level IN ('error', 'warning')
      GROUP BY ai_status, ai_category
      ORDER BY ai_status, ai_category
    `);
  const feedback = await client.query(`
      SELECT ai_status, ai_category, COUNT(*)::bigint AS items
      FROM feedback
      GROUP BY ai_status, ai_category
      ORDER BY ai_status, ai_category
    `);
  const database = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::int
          AS lock_waiters,
        COUNT(*) FILTER (
          WHERE wait_event_type = 'Lock'
            AND wait_event IS DISTINCT FROM 'advisory'
        )::int AS relation_lock_waiters
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
    `);
  console.log(JSON.stringify({
    queue: queue.rows,
    errors: errors.rows,
    feedback: feedback.rows,
    database: database.rows[0],
  }));
} finally {
  await client.end();
}
