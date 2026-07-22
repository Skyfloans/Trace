-- The retention purge checks rollup existence by group_id. Without this index,
-- cleanup scans the rollup table repeatedly and can block ingestion for many
-- minutes on a production-sized error_groups table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    occurrence_rollups_group_id_idx
    ON occurrence_rollups_hourly (group_id);
