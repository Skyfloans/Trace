BEGIN;

-- Do not wait behind a long-running telemetry query. This migration is safe to
-- retry because every schema operation is conditional.
SET LOCAL lock_timeout = '5s';

-- A display group can combine several exact error groups without changing or
-- deleting any of them. The exact fingerprint remains the ingestion identity;
-- these fields are only the read-model identity shown in the portal.
ALTER TABLE error_groups
    ADD COLUMN IF NOT EXISTS display_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS display_message TEXT,
    ADD COLUMN IF NOT EXISTS display_source_script TEXT;

COMMIT;

-- Existing rows fall back to their exact fingerprint until the targeted
-- backfill reaches them. Build the effective lookup index without blocking
-- ingestion writes on this production-sized table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    error_groups_project_effective_display_fingerprint_idx
    ON error_groups (project_id, (COALESCE(display_fingerprint, fingerprint)));
