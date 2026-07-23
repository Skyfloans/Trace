-- Run outside a transaction after migration 019. These indexes keep category
-- filters on the same bounded, index-backed paths as the existing fast lists.
CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_groups_ai_category_recent_idx
    ON display_error_groups (
        project_id,
        ai_category,
        last_seen_at DESC,
        fingerprint DESC
    )
    WHERE ai_category IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS display_error_rollups_ai_filter_idx
    ON display_error_rollups_hourly (
        project_id,
        ai_category,
        bucket_at,
        level,
        source,
        display_group_id
    )
    INCLUDE (event_count, first_seen_at, last_seen_at)
    WHERE ai_category IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS feedback_project_ai_category_time_idx
    ON feedback (
        project_id,
        ai_category,
        submitted_at DESC,
        id DESC
    )
    WHERE ai_category IS NOT NULL;
