BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE log_source AS ENUM ('client', 'server');
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warning', 'error');

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    roblox_job_id TEXT NOT NULL,
    place_id BIGINT NOT NULL,
    release TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, roblox_job_id)
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id),
    player_id BIGINT NOT NULL,
    player_name TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL,
    end_reason TEXT
);

CREATE TABLE error_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    source log_source NOT NULL,
    level log_level NOT NULL,
    normalized_message TEXT NOT NULL,
    normalized_stack TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    occurrence_count BIGINT NOT NULL DEFAULT 1,
    UNIQUE (project_id, fingerprint)
);

CREATE TABLE occurrences (
    id UUID NOT NULL,
    project_id UUID NOT NULL,
    group_id UUID NOT NULL REFERENCES error_groups(id),
    job_id UUID NOT NULL REFERENCES jobs(id),
    session_id UUID REFERENCES sessions(id),
    occurred_at TIMESTAMPTZ NOT NULL,
    original_message TEXT,
    context JSONB,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX sessions_player_time_idx
    ON sessions (project_id, player_id, started_at DESC);

CREATE INDEX occurrences_group_time_idx
    ON occurrences (group_id, occurred_at DESC);

CREATE INDEX occurrences_session_time_idx
    ON occurrences (session_id, occurred_at DESC);

CREATE INDEX occurrences_job_time_idx
    ON occurrences (job_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION ensure_occurrence_partitions(days_ahead INTEGER DEFAULT 3)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    partition_date DATE;
    partition_name TEXT;
    range_start TEXT;
    range_end TEXT;
BEGIN
    IF days_ahead < 0 THEN
        RAISE EXCEPTION 'days_ahead cannot be negative';
    END IF;

    FOR partition_date IN
        SELECT generate_series(
            (now() AT TIME ZONE 'UTC')::date - 3,
            (now() AT TIME ZONE 'UTC')::date + days_ahead,
            INTERVAL '1 day'
        )::date
    LOOP
        partition_name := 'occurrences_' || to_char(partition_date, 'YYYY_MM_DD');
        range_start := partition_date::text || ' 00:00:00+00';
        range_end := (partition_date + 1)::text || ' 00:00:00+00';

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF occurrences FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            range_start,
            range_end
        );
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION purge_expired_trace_data(retention INTERVAL DEFAULT INTERVAL '3 days')
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    partition RECORD;
    partition_date DATE;
    cutoff TIMESTAMPTZ := now() - retention;
BEGIN
    IF retention <= INTERVAL '0 seconds' THEN
        RAISE EXCEPTION 'retention must be positive';
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

        IF partition_date + 1 <= (cutoff AT TIME ZONE 'UTC')::date THEN
            EXECUTE format('DROP TABLE IF EXISTS %I', partition.partition_name);
        END IF;
    END LOOP;

    DELETE FROM sessions
    WHERE COALESCE(ended_at, last_seen_at) < cutoff
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.session_id = sessions.id
      );

    DELETE FROM error_groups
    WHERE last_seen_at < cutoff
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.group_id = error_groups.id
      );

    DELETE FROM jobs
    WHERE COALESCE(ended_at, last_seen_at) < cutoff
      AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE sessions.job_id = jobs.id
      )
      AND NOT EXISTS (
          SELECT 1 FROM occurrences WHERE occurrences.job_id = jobs.id
      );
END;
$$;

SELECT ensure_occurrence_partitions(3);

COMMIT;
