BEGIN;

CREATE TABLE roblox_autofix_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES roblox_place_snapshots(id) ON DELETE CASCADE,
    requested_by_credential_id UUID REFERENCES roblox_plugin_credentials(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    max_proposals SMALLINT NOT NULL DEFAULT 15
        CHECK (max_proposals BETWEEN 1 AND 15),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX roblox_autofix_runs_project_created_idx
    ON roblox_autofix_runs (project_id, created_at DESC);

CREATE TABLE roblox_autofix_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES roblox_autofix_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES roblox_place_snapshots(id) ON DELETE CASCADE,
    error_group_id UUID NOT NULL REFERENCES display_error_groups(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued', 'processing', 'ready', 'unable', 'failed',
            'accepted', 'rejected', 'conflict'
        )),
    priority_rank SMALLINT NOT NULL,
    ai_category error_ai_category NOT NULL,
    title TEXT,
    summary TEXT,
    confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    failure_reason TEXT,
    reviewed_by_credential_id UUID REFERENCES roblox_plugin_credentials(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (snapshot_id, error_group_id)
);

CREATE INDEX roblox_autofix_proposals_queue_idx
    ON roblox_autofix_proposals (status, priority_rank, created_at, id);
CREATE INDEX roblox_autofix_proposals_project_review_idx
    ON roblox_autofix_proposals (project_id, status, updated_at DESC);

CREATE TABLE roblox_autofix_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id UUID NOT NULL REFERENCES roblox_autofix_proposals(id) ON DELETE CASCADE,
    script_path TEXT NOT NULL,
    script_class TEXT NOT NULL
        CHECK (script_class IN ('Script', 'LocalScript', 'ModuleScript')),
    base_source_sha256 TEXT NOT NULL CHECK (base_source_sha256 ~ '^[0-9a-f]{64}$'),
    base_source TEXT NOT NULL CHECK (octet_length(base_source) <= 1048576),
    proposed_source TEXT NOT NULL CHECK (octet_length(proposed_source) <= 1048576),
    patch JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (proposal_id, script_path)
);

COMMIT;
