BEGIN;

ALTER TYPE log_level RENAME VALUE 'debug' TO 'trace';

ALTER TABLE projects
    ADD COLUMN roblox_universe_id TEXT,
    ADD COLUMN icon_url TEXT;

ALTER TABLE jobs
    ADD COLUMN region TEXT;

ALTER TABLE sessions
    ADD COLUMN player_display_name TEXT,
    ADD COLUMN avatar_url TEXT,
    ADD COLUMN device TEXT,
    ADD COLUMN platform TEXT;

ALTER TABLE occurrences
    ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TYPE project_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_memberships (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role project_role NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, project_id)
);

CREATE TABLE web_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX web_sessions_active_token_idx
    ON web_sessions (token_hash, expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX project_memberships_project_user_idx
    ON project_memberships (project_id, user_id);

DROP INDEX occurrences_group_time_idx;
DROP INDEX occurrences_session_time_idx;
DROP INDEX occurrences_job_time_idx;
DROP INDEX sessions_player_time_idx;

CREATE INDEX occurrences_project_time_id_idx
    ON occurrences (project_id, occurred_at DESC, id DESC);

CREATE INDEX occurrences_project_group_time_idx
    ON occurrences (project_id, group_id, occurred_at DESC, id DESC);

CREATE INDEX occurrences_project_session_time_idx
    ON occurrences (project_id, session_id, occurred_at, id);

CREATE INDEX occurrences_project_job_time_idx
    ON occurrences (project_id, job_id, occurred_at, id);

CREATE INDEX sessions_project_player_time_idx
    ON sessions (project_id, player_id, started_at DESC, id DESC);

CREATE INDEX sessions_project_time_idx
    ON sessions (project_id, started_at DESC, id DESC);

CREATE INDEX sessions_project_player_name_idx
    ON sessions (project_id, lower(player_name) text_pattern_ops);

CREATE INDEX jobs_project_time_idx
    ON jobs (project_id, started_at DESC, id DESC);

COMMIT;