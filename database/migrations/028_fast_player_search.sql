-- Player search combines username, display-name, and exact numeric-ID matches.
-- The username index was added in migration 003; without the corresponding
-- display-name index PostgreSQL must scan every retained session in a project.
--
-- Run outside a transaction so production reads and ingestion remain available.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_project_player_display_name_idx
    ON sessions (project_id, lower(player_display_name) text_pattern_ops);
