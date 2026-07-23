import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query("SET statement_timeout = '15s'");
  const result = await client.query(`
    SELECT
      (SELECT n_live_tup::bigint FROM pg_stat_user_tables
       WHERE relname = 'display_error_groups') AS display_groups_estimate,
      (SELECT n_live_tup::bigint FROM pg_stat_user_tables
       WHERE relname = 'feedback') AS feedback_rows_estimate,
      (SELECT n_live_tup::bigint FROM pg_stat_user_tables
       WHERE relname = 'display_error_rollups_hourly')
        AS display_rollups_estimate,
      (
        SELECT COALESCE(SUM(project_counts.active_groups), 0)::bigint
        FROM projects
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::bigint AS active_groups
          FROM display_error_groups
          WHERE display_error_groups.project_id = projects.id
            AND display_error_groups.last_seen_at >= now() - interval '3 days'
            AND display_error_groups.level IN ('error', 'warning')
        ) project_counts
      ) AS active_error_groups,
      pg_size_pretty(pg_total_relation_size('display_error_groups'))
        AS display_groups_size,
      pg_size_pretty(pg_total_relation_size('feedback')) AS feedback_size,
      pg_size_pretty(pg_total_relation_size('display_error_rollups_hourly'))
        AS display_rollups_size,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'display_error_groups'
          AND column_name = 'ai_category'
      ) AS migration_019_present,
      (
        SELECT COUNT(*)::int
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      ) AS lock_waiters,
      (
        SELECT COUNT(*)::int
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event <> 'advisory'
      ) AS relation_lock_waiters,
      EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND query ILIKE '%purge_expired_trace_data%'
      ) AS purge_active
  `);
  console.log(JSON.stringify(result.rows[0]));
} finally {
  await client.end();
}
