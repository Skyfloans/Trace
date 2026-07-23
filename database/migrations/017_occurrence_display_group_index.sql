BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Denormalize the display group onto retained raw occurrences so detail
-- drill-downs never need one index probe per historical exact group.
ALTER TABLE occurrences
    ADD COLUMN IF NOT EXISTS display_group_id UUID;

-- The parent is intentionally created without building child indexes. The
-- online backfill builds each partition index concurrently, attaches it, then
-- marks the read path ready only after every retained row is verified.
CREATE INDEX IF NOT EXISTS occurrences_project_display_group_time_idx
    ON ONLY occurrences (
        project_id,
        display_group_id,
        occurred_at DESC,
        id DESC
    );

COMMIT;
