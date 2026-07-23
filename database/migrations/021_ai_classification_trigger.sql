BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION enqueue_ai_classification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    classification_target ai_classification_target;
BEGIN
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
