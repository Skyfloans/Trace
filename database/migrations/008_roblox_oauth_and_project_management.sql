BEGIN;

ALTER TABLE users
    ALTER COLUMN email DROP NOT NULL,
    ADD COLUMN roblox_user_id TEXT,
    ADD COLUMN roblox_username TEXT,
    ADD COLUMN roblox_display_name TEXT,
    ADD COLUMN roblox_avatar_url TEXT,
    ADD COLUMN last_login_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_roblox_user_id_idx
    ON users (roblox_user_id)
    WHERE roblox_user_id IS NOT NULL;

CREATE UNIQUE INDEX projects_roblox_universe_id_idx
    ON projects (roblox_universe_id)
    WHERE roblox_universe_id IS NOT NULL;

CREATE UNIQUE INDEX project_single_owner_idx
    ON project_memberships (project_id)
    WHERE role = 'owner';

ALTER TABLE project_api_keys
    ADD COLUMN key_hint TEXT;

CREATE TABLE roblox_oauth_flows (
    state_hash BYTEA PRIMARY KEY,
    browser_binding_hash BYTEA NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    intent TEXT NOT NULL CHECK (intent IN ('login', 'claim')),
    universe_id TEXT,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK ((intent = 'claim') = (user_id IS NOT NULL AND universe_id IS NOT NULL))
);

CREATE INDEX roblox_oauth_flows_expiry_idx
    ON roblox_oauth_flows (expires_at);

CREATE TABLE verified_universe_claims (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    universe_id TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, universe_id)
);

CREATE INDEX verified_universe_claims_expiry_idx
    ON verified_universe_claims (expires_at);

CREATE TABLE project_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    roblox_user_id TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    role project_role NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (role <> 'owner')
);

CREATE UNIQUE INDEX project_invitations_active_recipient_idx
    ON project_invitations (project_id, roblox_user_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX project_invitations_recipient_idx
    ON project_invitations (roblox_user_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMIT;
