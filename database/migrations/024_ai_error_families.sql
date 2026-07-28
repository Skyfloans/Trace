BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION normalize_ai_error_family(message_value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $function$
    SELECT lower(
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    regexp_replace(
                        regexp_replace(
                            CASE
                                WHEN message_value LIKE
                                    'DataStore request was added to queue.%'
                                    THEN 'DataStore request was added to queue'
                                WHEN message_value LIKE
                                    'Infinite yield possible on %'
                                    THEN 'Infinite yield possible'
                                WHEN message_value LIKE
                                    'A new version of TopbarPlus %'
                                    THEN 'TopbarPlus update available'
                                WHEN message_value LIKE
                                    'Player:Move called,%'
                                    THEN 'Player Move called without character'
                                WHEN message_value LIKE
                                    '⌛%Played for %New Server Average Session Time:%'
                                    THEN 'Player session duration diagnostic'
                                WHEN message_value LIKE
                                    '[BadgeAwardService] Could not award %'
                                    THEN 'BadgeAwardService could not award badge'
                                WHEN message_value LIKE
                                    'Script has run for over % seconds and may timeout%'
                                    THEN 'Script timeout warning'
                                ELSE message_value
                            END,
                            '<(PLAYER_ID|PLAYER_NAME|ID|UUID|TIMESTAMP|ADDRESS|ROBLOX_JOB_ID)>',
                            '<VALUE>',
                            'g'
                        ),
                        'https?://[^[:space:]]+',
                        '<URL>',
                        'g'
                    ),
                    '''[^'']*''',
                    '''<VALUE>''',
                    'g'
                ),
                '"[^"]*"',
                '"<VALUE>"',
                'g'
            ),
            '[0-9]+([.][0-9]+)*',
            '<NUMBER>',
            'g'
        )
    )
$function$;

CREATE OR REPLACE FUNCTION ai_error_family_key(
    source_value TEXT,
    level_value TEXT,
    message_value TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $function$
    SELECT encode(
        digest(
            source_value || '|' || level_value || '|' ||
            normalize_ai_error_family(message_value),
            'sha256'
        ),
        'hex'
    )
$function$;

ALTER TABLE display_error_groups
    ADD COLUMN IF NOT EXISTS ai_family_key TEXT;

CREATE TABLE IF NOT EXISTS ai_error_family_classifications (
    family_key TEXT PRIMARY KEY,
    category error_ai_category NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    classified_at TIMESTAMPTZ NOT NULL,
    model TEXT NOT NULL,
    prompt_version INTEGER NOT NULL
);

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    display_error_groups_ai_family_key_idx
    ON display_error_groups (ai_family_key)
    WHERE ai_family_key IS NOT NULL;
