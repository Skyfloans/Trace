BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS ai_translated BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
