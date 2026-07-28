BEGIN;

ALTER TABLE roblox_oauth_flows
    DROP CONSTRAINT roblox_oauth_flows_intent_check,
    DROP CONSTRAINT roblox_oauth_flows_check,
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    ADD COLUMN target_universe_id TEXT;

ALTER TABLE roblox_oauth_flows
    ADD CONSTRAINT roblox_oauth_flows_intent_check
        CHECK (intent IN ('login', 'claim', 'place_access')),
    ADD CONSTRAINT roblox_oauth_flows_shape_check CHECK (
        (intent = 'login'
            AND universe_id IS NULL
            AND project_id IS NULL
            AND target_universe_id IS NULL)
        OR
        (intent = 'claim'
            AND user_id IS NOT NULL
            AND universe_id IS NOT NULL
            AND project_id IS NULL
            AND target_universe_id IS NULL)
        OR
        (intent = 'place_access'
            AND user_id IS NOT NULL
            AND universe_id IS NULL
            AND project_id IS NOT NULL
            AND target_universe_id IS NOT NULL)
    );

CREATE TABLE roblox_place_oauth_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    authorized_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    roblox_user_id TEXT NOT NULL,
    target_universe_id TEXT NOT NULL,
    root_place_id TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    access_token_ciphertext BYTEA NOT NULL,
    access_token_expires_at TIMESTAMPTZ NOT NULL,
    refresh_token_ciphertext BYTEA NOT NULL,
    authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    refreshed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_error_code TEXT,
    last_error_at TIMESTAMPTZ
);

CREATE INDEX roblox_place_oauth_grants_target_idx
    ON roblox_place_oauth_grants (target_universe_id)
    WHERE revoked_at IS NULL;

CREATE TABLE roblox_place_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    grant_id UUID NOT NULL REFERENCES roblox_place_oauth_grants(id) ON DELETE CASCADE,
    target_universe_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 104857600),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX roblox_place_snapshots_project_created_idx
    ON roblox_place_snapshots (project_id, created_at DESC);

COMMIT;
