BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Compact, display-level metadata lets recent error lists stop after the
-- requested page instead of grouping every exact error row first.
CREATE TABLE IF NOT EXISTS display_error_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    level log_level NOT NULL,
    source log_source NOT NULL,
    normalized_message TEXT NOT NULL,
    source_script TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, fingerprint),
    CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS display_error_groups_recent_idx
    ON display_error_groups (
        project_id,
        last_seen_at DESC,
        fingerprint DESC
    );

-- Exact groups remain untouched and fetchable. This narrow map is the bridge
-- from a displayed group back to every exact variant it represents.
CREATE TABLE IF NOT EXISTS display_error_group_members (
    exact_group_id UUID PRIMARY KEY REFERENCES error_groups(id) ON DELETE CASCADE,
    display_group_id UUID NOT NULL REFERENCES display_error_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS display_error_group_members_display_idx
    ON display_error_group_members (display_group_id, exact_group_id);

-- Reads aggregate at most one row per displayed group per hour. The exact
-- occurrence and exact rollup tables continue to preserve drill-down data.
CREATE TABLE IF NOT EXISTS display_error_rollups_hourly (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_group_id UUID NOT NULL REFERENCES display_error_groups(id) ON DELETE CASCADE,
    bucket_at TIMESTAMPTZ NOT NULL,
    event_count BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, display_group_id, bucket_at),
    CHECK (event_count > 0),
    CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS display_error_rollups_project_bucket_idx
    ON display_error_rollups_hourly (project_id, bucket_at, display_group_id)
    INCLUDE (event_count, first_seen_at, last_seen_at);

COMMIT;
