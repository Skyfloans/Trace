BEGIN;

CREATE TABLE roblox_autofix_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    proposal_id UUID NOT NULL REFERENCES roblox_autofix_proposals(id) ON DELETE CASCADE,
    script_path TEXT NOT NULL,
    script_class TEXT NOT NULL
        CHECK (script_class IN ('Script', 'LocalScript', 'ModuleScript')),
    previous_source TEXT NOT NULL CHECK (octet_length(previous_source) <= 1048576),
    applied_source TEXT NOT NULL CHECK (octet_length(applied_source) <= 1048576),
    accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_by_name TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    restored_by_name TEXT,
    restored_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
    UNIQUE (proposal_id, script_path)
);

CREATE INDEX roblox_autofix_history_project_accepted_idx
    ON roblox_autofix_history (project_id, accepted_at DESC);
CREATE INDEX roblox_autofix_history_expiry_idx
    ON roblox_autofix_history (expires_at);

COMMIT;
