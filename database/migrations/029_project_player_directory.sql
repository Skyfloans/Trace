-- Keep one searchable row per retained player instead of searching every
-- historical session. Apply before deploying the corresponding API version.
CREATE TABLE IF NOT EXISTS project_players (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL,
    player_name TEXT,
    player_display_name TEXT,
    avatar_url TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, player_id)
);

CREATE INDEX IF NOT EXISTS project_players_recent_idx
    ON project_players (project_id, last_seen_at DESC, player_id DESC);

CREATE INDEX IF NOT EXISTS project_players_name_idx
    ON project_players (project_id, lower(player_name) text_pattern_ops);

CREATE INDEX IF NOT EXISTS project_players_display_name_idx
    ON project_players (project_id, lower(player_display_name) text_pattern_ops);

INSERT INTO project_players (
    project_id, player_id, player_name, player_display_name, avatar_url,
    last_seen_at
)
SELECT DISTINCT ON (sessions.project_id, sessions.player_id)
    sessions.project_id,
    sessions.player_id,
    sessions.player_name,
    sessions.player_display_name,
    sessions.avatar_url,
    sessions.last_seen_at
FROM sessions
ORDER BY
    sessions.project_id,
    sessions.player_id,
    sessions.started_at DESC,
    sessions.id DESC
ON CONFLICT (project_id, player_id) DO UPDATE
SET player_name = EXCLUDED.player_name,
    player_display_name = EXCLUDED.player_display_name,
    avatar_url = COALESCE(EXCLUDED.avatar_url, project_players.avatar_url),
    last_seen_at = GREATEST(
        EXCLUDED.last_seen_at,
        project_players.last_seen_at
    );
