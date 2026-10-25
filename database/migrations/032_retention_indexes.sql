-- Run outside a transaction. Retention deletes parents (sessions, jobs,
-- display_error_groups) whose foreign keys are checked or cascaded by
-- display_group_id, job_id, or session_id alone. Without these indexes every
-- deleted parent row scans the child table, which made retention unable to keep
-- up. The expression indexes let the hourly purge find expired rows directly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feedback_session_idx
    ON feedback (session_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_variants_hourly_group_idx
    ON display_error_variants_hourly (display_group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_rollups_hourly_group_idx
    ON display_error_rollups_hourly (display_group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_group_players_group_idx
    ON display_error_group_players (display_group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_group_jobs_group_idx
    ON display_error_group_jobs (display_group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_group_jobs_job_idx
    ON display_error_group_jobs (job_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_job_idx
    ON sessions (job_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_retention_idx
    ON sessions ((COALESCE(ended_at, last_seen_at)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_retention_idx
    ON jobs ((COALESCE(ended_at, last_seen_at)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS error_groups_retention_idx
    ON error_groups (last_seen_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_groups_retention_idx
    ON display_error_groups (last_seen_at);

-- occurrences is partitioned, so its single-column foreign key indexes are
-- built per partition without blocking ingestion and then attached. Partitions
-- created later inherit the parent index automatically. Every existing
-- occurrences_YYYY_MM_DD partition must be attached before the parent index is
-- valid; repeat the CONCURRENTLY + ATTACH pair below for each one.
CREATE INDEX IF NOT EXISTS occurrences_session_id_idx ON ONLY occurrences (session_id);
CREATE INDEX IF NOT EXISTS occurrences_group_id_idx ON ONLY occurrences (group_id);
CREATE INDEX IF NOT EXISTS occurrences_job_id_idx ON ONLY occurrences (job_id);
-- For each partition p:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS p_session_id_idx ON p (session_id);
--   ALTER INDEX occurrences_session_id_idx ATTACH PARTITION p_session_id_idx;
--   (and the same for group_id and job_id)
