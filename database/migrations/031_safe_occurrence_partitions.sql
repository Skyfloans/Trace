BEGIN;

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

    -- Serialize DDL across API instances. Checking before CREATE also avoids
    -- taking heavyweight locks on every existing partition during ingestion.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('trace-occurrence-partitions', 0)
    );

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

        IF to_regclass(format('%I.%I', current_schema(), partition_name)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS %I PARTITION OF occurrences FOR VALUES FROM (%L) TO (%L)',
                partition_name,
                range_start,
                range_end
            );
        END IF;
    END LOOP;
END;
$$;

SELECT ensure_occurrence_partitions(3);

COMMIT;
