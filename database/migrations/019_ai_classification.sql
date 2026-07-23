-- This migration is deliberately split into idempotent, short transactions.
-- Ingestion touches all three target tables, so locking them together can form
-- a deadlock cycle under load.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
    CREATE TYPE error_ai_category AS ENUM (
        'critical', 'high', 'medium', 'low', 'not_a_bug'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE feedback_ai_category AS ENUM (
        'bug_report', 'critique', 'suggestion', 'general'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE ai_classification_status AS ENUM (
        'pending', 'classified', 'failed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE ai_classification_target AS ENUM ('error', 'feedback');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ai_classification_jobs (
    target_type ai_classification_target NOT NULL,
    target_id UUID NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing')),
    priority SMALLINT NOT NULL DEFAULT 0,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    locked_by UUID,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS ai_classification_jobs_ready_idx
    ON ai_classification_jobs (
        status,
        priority DESC,
        available_at,
        created_at
    );

CREATE OR REPLACE FUNCTION enqueue_ai_classification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    classification_target ai_classification_target;
BEGIN
    -- Branch on the trigger relation before reading relation-specific fields.
    -- PostgreSQL trigger records do not expose missing columns, and boolean
    -- expressions are not guaranteed to short-circuit field evaluation.
    IF TG_TABLE_NAME = 'display_error_groups' THEN
        IF NEW.level NOT IN ('error', 'warning') THEN
            RETURN NEW;
        END IF;
        classification_target := 'error'::ai_classification_target;
    ELSIF TG_TABLE_NAME = 'feedback' THEN
        classification_target := 'feedback'::ai_classification_target;
    ELSE
        RAISE EXCEPTION 'Unsupported AI classification target table: %',
            TG_TABLE_NAME;
    END IF;

    INSERT INTO ai_classification_jobs (
        target_type,
        target_id,
        project_id,
        priority
    )
    VALUES (
        classification_target,
        NEW.id,
        NEW.project_id,
        10
    )
    ON CONFLICT (target_type, target_id) DO NOTHING;
    RETURN NEW;
END;
$$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE display_error_groups
    ADD COLUMN IF NOT EXISTS ai_category error_ai_category,
    ADD COLUMN IF NOT EXISTS ai_confidence REAL,
    ADD COLUMN IF NOT EXISTS ai_reason TEXT,
    ADD COLUMN IF NOT EXISTS ai_classified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ai_model TEXT,
    ADD COLUMN IF NOT EXISTS ai_prompt_version INTEGER,
    ADD COLUMN IF NOT EXISTS ai_status ai_classification_status
        NOT NULL DEFAULT 'pending';

DO $$ BEGIN
    ALTER TABLE display_error_groups
        ADD CONSTRAINT display_error_groups_ai_confidence_check
        CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1)
        NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TRIGGER IF EXISTS display_error_groups_enqueue_ai
    ON display_error_groups;
CREATE TRIGGER display_error_groups_enqueue_ai
AFTER INSERT ON display_error_groups
FOR EACH ROW EXECUTE FUNCTION enqueue_ai_classification();

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE display_error_rollups_hourly
    ADD COLUMN IF NOT EXISTS ai_category error_ai_category;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS ai_category feedback_ai_category,
    ADD COLUMN IF NOT EXISTS ai_confidence REAL,
    ADD COLUMN IF NOT EXISTS ai_reason TEXT,
    ADD COLUMN IF NOT EXISTS ai_classified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ai_model TEXT,
    ADD COLUMN IF NOT EXISTS ai_prompt_version INTEGER,
    ADD COLUMN IF NOT EXISTS ai_status ai_classification_status
        NOT NULL DEFAULT 'pending';

DO $$ BEGIN
    ALTER TABLE feedback
        ADD CONSTRAINT feedback_ai_confidence_check
        CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1)
        NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TRIGGER IF EXISTS feedback_enqueue_ai ON feedback;
CREATE TRIGGER feedback_enqueue_ai
AFTER INSERT ON feedback
FOR EACH ROW EXECUTE FUNCTION enqueue_ai_classification();

COMMIT;
