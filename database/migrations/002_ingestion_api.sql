BEGIN;

ALTER TABLE error_groups
    ALTER COLUMN occurrence_count SET DEFAULT 0,
    ADD COLUMN source_script TEXT;

ALTER TABLE occurrences
    ADD COLUMN original_stack TEXT;

CREATE TABLE project_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash BYTEA NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX project_api_keys_project_idx
    ON project_api_keys (project_id)
    WHERE revoked_at IS NULL;

COMMIT;
