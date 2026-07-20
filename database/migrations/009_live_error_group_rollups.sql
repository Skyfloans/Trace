BEGIN;

-- The archival path already stores exact hourly group totals in
-- occurrence_rollups_hourly before dropping an occurrence partition. Backfill
-- every raw partition that is still online so the same table can serve as the
-- read model for both live and archived grouped-log queries.
--
-- Ingestion dual-writes occurrences and their hourly totals in one transaction.
-- Hold writes during the one-time snapshot so a concurrent batch cannot update
-- a bucket between the snapshot and its replacement below. Inserts resume as
-- soon as this transaction commits.
LOCK TABLE occurrences IN SHARE MODE;

INSERT INTO occurrence_rollups_hourly (
    project_id,
    group_id,
    bucket_at,
    event_count,
    affected_player_count,
    affected_server_count,
    first_seen_at,
    last_seen_at
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
FROM occurrences o
LEFT JOIN sessions s ON s.id = o.session_id
GROUP BY o.project_id, o.group_id, 3
ON CONFLICT (project_id, group_id, bucket_at) DO UPDATE
SET event_count = EXCLUDED.event_count,
    affected_player_count = EXCLUDED.affected_player_count,
    affected_server_count = EXCLUDED.affected_server_count,
    first_seen_at = EXCLUDED.first_seen_at,
    last_seen_at = EXCLUDED.last_seen_at;

-- The API checks this marker before trusting hourly rollups for current data.
-- Deploy the dual-write API before applying this migration; the transaction
-- makes the backfill and readiness marker visible atomically.
CREATE TABLE trace_read_model_state (
    key TEXT PRIMARY KEY,
    ready_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO trace_read_model_state (key)
VALUES ('live_error_group_rollups_v1');

COMMIT;
