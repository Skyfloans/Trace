-- Nullable columns keep this online-safe while the existing two million
-- rollups are backfilled. Reads switch only after a verified readiness marker.
ALTER TABLE display_error_rollups_hourly
    ADD COLUMN IF NOT EXISTS level log_level,
    ADD COLUMN IF NOT EXISTS source log_source;
