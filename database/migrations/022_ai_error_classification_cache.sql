BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Error fingerprints are stable across projects. Cache the AI decision once so
-- the same normalized Roblox/Luau error is never paid for once per game.
CREATE TABLE IF NOT EXISTS ai_error_classifications (
    fingerprint TEXT PRIMARY KEY,
    category error_ai_category NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    classified_at TIMESTAMPTZ NOT NULL,
    model TEXT NOT NULL,
    prompt_version INTEGER NOT NULL
);

COMMIT;
