BEGIN;

ALTER TABLE roblox_oauth_flows
    ADD COLUMN return_path TEXT;

CREATE TABLE roblox_plugin_pairing_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    browser_token_hash BYTEA NOT NULL UNIQUE,
    client_proof_hash BYTEA NOT NULL,
    roblox_user_id TEXT NOT NULL CHECK (roblox_user_id ~ '^[1-9][0-9]{0,19}$'),
    studio_universe_id TEXT NOT NULL CHECK (studio_universe_id ~ '^[1-9][0-9]{0,19}$'),
    studio_place_id TEXT NOT NULL CHECK (studio_place_id ~ '^[1-9][0-9]{0,19}$'),
    install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 8 AND 80),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    approved_by UUID REFERENCES users(id) ON DELETE CASCADE,
    code_hash BYTEA,
    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX roblox_plugin_pairing_requests_expiry_idx
    ON roblox_plugin_pairing_requests (expires_at)
    WHERE status IN ('pending', 'approved');

CREATE TABLE roblox_plugin_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash BYTEA NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    roblox_user_id TEXT NOT NULL,
    install_id TEXT NOT NULL,
    source_universe_id TEXT NOT NULL,
    target_universe_id TEXT NOT NULL,
    studio_place_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX roblox_plugin_credentials_project_idx
    ON roblox_plugin_credentials (project_id, created_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX roblox_plugin_credentials_user_idx
    ON roblox_plugin_credentials (user_id, created_at DESC)
    WHERE revoked_at IS NULL;

COMMIT;
