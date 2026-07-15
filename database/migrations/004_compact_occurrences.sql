BEGIN;

-- One occurrence row can represent many identical events captured during a
-- short SDK flush window. Existing rows remain one-event aggregates.
ALTER TABLE occurrences
    ADD COLUMN last_occurred_at TIMESTAMPTZ,
    ADD COLUMN repeat_count INTEGER;

UPDATE occurrences
SET last_occurred_at = occurred_at,
    repeat_count = 1
WHERE last_occurred_at IS NULL OR repeat_count IS NULL;

ALTER TABLE occurrences
    ALTER COLUMN repeat_count SET NOT NULL,
    ALTER COLUMN repeat_count SET DEFAULT 1,
    ADD CONSTRAINT occurrences_repeat_count_check
        CHECK (repeat_count BETWEEN 1 AND 10000),
    ADD CONSTRAINT occurrences_time_order_check
        CHECK (
            last_occurred_at IS NULL
            OR last_occurred_at >= occurred_at
        );

-- last_occurred_at intentionally remains nullable during rollout. The old API
-- omits it, while the new read API treats NULL as occurred_at. New ingestion
-- always supplies it, so a later migration may enforce NOT NULL after every
-- API instance is upgraded.

COMMIT;
