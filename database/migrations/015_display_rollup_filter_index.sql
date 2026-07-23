-- Build this after metadata backfill so two million updates do not also have
-- to rewrite the new index. CONCURRENTLY keeps ingestion online.
CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_rollups_filter_idx
    ON display_error_rollups_hourly (
        project_id,
        bucket_at,
        display_group_id
    )
    INCLUDE (
        event_count,
        first_seen_at,
        last_seen_at,
        level,
        source
    );
