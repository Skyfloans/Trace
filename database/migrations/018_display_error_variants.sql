BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS display_error_variants_hourly (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_group_id UUID NOT NULL REFERENCES display_error_groups(id)
        ON DELETE CASCADE,
    bucket_at TIMESTAMPTZ NOT NULL,
    message_hash BYTEA NOT NULL,
    message TEXT NOT NULL,
    event_count BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, display_group_id, bucket_at, message_hash)
);

CREATE INDEX IF NOT EXISTS display_error_variants_retention_idx
    ON display_error_variants_hourly (bucket_at);

COMMIT;
