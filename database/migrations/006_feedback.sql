BEGIN;

CREATE TABLE feedback (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Feedback outlives detailed session retention. The link remains while the
    -- session is retained and becomes null when tiered cleanup removes it.
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    player_id BIGINT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL,
    message TEXT NOT NULL,
    CHECK (char_length(message) BETWEEN 8 AND 500)
);

CREATE INDEX feedback_project_time_idx
    ON feedback (project_id, submitted_at DESC);

CREATE INDEX feedback_project_player_time_idx
    ON feedback (project_id, player_id, submitted_at DESC);

COMMIT;
