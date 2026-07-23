BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Exact occurrences remain authoritative. These compact sets make distinct
-- player/job counts proportional to the answer instead of the raw event count.
CREATE TABLE IF NOT EXISTS display_error_group_players (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_group_id UUID NOT NULL REFERENCES display_error_groups(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, display_group_id, player_id)
);

CREATE INDEX IF NOT EXISTS display_error_group_players_retention_idx
    ON display_error_group_players (last_seen_at);

CREATE TABLE IF NOT EXISTS display_error_group_jobs (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_group_id UUID NOT NULL REFERENCES display_error_groups(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, display_group_id, job_id)
);

CREATE INDEX IF NOT EXISTS display_error_group_jobs_retention_idx
    ON display_error_group_jobs (last_seen_at);

CREATE OR REPLACE FUNCTION purge_expired_display_error_impacts(
    aggregate_retention INTERVAL DEFAULT INTERVAL '3 days'
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    aggregate_cutoff TIMESTAMPTZ := now() - aggregate_retention;
BEGIN
    IF aggregate_retention <= INTERVAL '0 seconds' THEN
        RAISE EXCEPTION 'aggregate_retention must be positive';
    END IF;

    DELETE FROM display_error_group_players
    WHERE last_seen_at < aggregate_cutoff;

    DELETE FROM display_error_group_jobs
    WHERE last_seen_at < aggregate_cutoff;
END;
$$;

COMMIT;
