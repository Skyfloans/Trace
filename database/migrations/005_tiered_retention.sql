BEGIN;

-- Hourly totals preserve trend data after detailed occurrence partitions are
-- dropped. They intentionally omit messages, stacks, and per-session rows.
CREATE TABLE occurrence_rollups_hourly (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
    bucket_at TIMESTAMPTZ NOT NULL,
    event_count BIGINT NOT NULL,
    affected_player_count INTEGER NOT NULL,
    affected_server_count INTEGER NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, group_id, bucket_at),
    CHECK (event_count > 0),
    CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX occurrence_rollups_project_bucket_idx
    ON occurrence_rollups_hourly (project_id, bucket_at);

DROP FUNCTION purge_expired_trace_data(INTERVAL);

CREATE FUNCTION purge_expired_trace_data(
    raw_retention INTERVAL DEFAULT INTERVAL '24 hours',
    aggregate_retention INTERVAL DEFAULT INTERVAL '3 days'
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    partition RECORD;
    partition_date DATE;
    raw_cutoff TIMESTAMPTZ := now() - raw_retention;
    aggregate_cutoff TIMESTAMPTZ := now() - aggregate_retention;
BEGIN
    IF raw_retention <= INTERVAL '0 seconds' THEN
        RAISE EXCEPTION 'raw_retention must be positive';
    END IF;
    IF aggregate_retention <= raw_retention THEN
        RAISE EXCEPTION 'aggregate_retention must exceed raw_retention';
    END IF;

    FOR partition IN
        SELECT child.relname AS partition_name
        FROM pg_inherits
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        WHERE parent.relname = 'occurrences'
          AND child.relname ~ '^occurrences_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    LOOP
        partition_date := to_date(
            substring(partition.partition_name FROM 13),
            'YYYY_MM_DD'
        );

        -- Daily partitions make raw retention vary between 24 and 48 hours,
        -- but allow expiration to be a cheap metadata drop instead of a large
        -- row-by-row DELETE. Roll up the complete partition first.
        IF partition_date + 1 <= (raw_cutoff AT TIME ZONE 'UTC')::date THEN
            EXECUTE format(
                $sql$
                INSERT INTO occurrence_rollups_hourly (
                    project_id, group_id, bucket_at, event_count,
                    affected_player_count, affected_server_count,
                    first_seen_at, last_seen_at
                )
                SELECT
                    o.project_id,
                    o.group_id,
                    date_trunc('hour', o.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                    SUM(o.repeat_count)::bigint,
                    COUNT(DISTINCT s.player_id)::int,
                    COUNT(DISTINCT o.job_id)::int,
                    MIN(o.occurred_at),
                    MAX(COALESCE(o.last_occurred_at, o.occurred_at))
                FROM %I o
                LEFT JOIN sessions s ON s.id = o.session_id
                GROUP BY o.project_id, o.group_id, 3
                ON CONFLICT (project_id, group_id, bucket_at) DO UPDATE
                SET event_count = EXCLUDED.event_count,
                    affected_player_count = EXCLUDED.affected_player_count,
                    affected_server_count = EXCLUDED.affected_server_count,
                    first_seen_at = EXCLUDED.first_seen_at,
                    last_seen_at = EXCLUDED.last_seen_at
                $sql$,
                partition.partition_name
            );

            EXECUTE format('DROP TABLE IF EXISTS %I', partition.partition_name);
        END IF;
    END LOOP;

    DELETE FROM occurrence_rollups_hourly
    WHERE bucket_at < aggregate_cutoff;

    DELETE FROM sessions
    WHERE COALESCE(ended_at, last_seen_at) < aggregate_cutoff
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.session_id = sessions.id
      );

    DELETE FROM error_groups
    WHERE last_seen_at < aggregate_cutoff
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.group_id = error_groups.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM occurrence_rollups_hourly
          WHERE occurrence_rollups_hourly.group_id = error_groups.id
      );

    DELETE FROM jobs
    WHERE COALESCE(ended_at, last_seen_at) < aggregate_cutoff
      AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE sessions.job_id = jobs.id
      )
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.job_id = jobs.id
      );
END;
$$;

COMMIT;
