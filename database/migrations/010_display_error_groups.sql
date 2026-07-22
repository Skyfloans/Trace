BEGIN;

-- A display group can combine several exact error groups without changing or
-- deleting any of them. The exact fingerprint remains the ingestion identity;
-- these fields are only the read-model identity shown in the portal.
ALTER TABLE error_groups
    ADD COLUMN display_fingerprint TEXT,
    ADD COLUMN display_message TEXT,
    ADD COLUMN display_source_script TEXT;

WITH display_values AS (
    SELECT
        id,
        regexp_replace(
            normalized_message,
            '(^|[^0-9])([0-9]{7,20})(?=[^0-9]|$)',
            '\1<ID>',
            'g'
        ) AS display_message,
        CASE
            WHEN source_script IS NULL THEN NULL
            ELSE regexp_replace(
                source_script,
                '(^|[^0-9])([0-9]{7,20})(?=[^0-9]|$)',
                '\1<ID>',
                'g'
            )
        END AS display_source_script
    FROM error_groups
), identities AS (
    SELECT
        error_groups.id,
        display_values.display_message,
        display_values.display_source_script,
        encode(
            digest(
                convert_to(error_groups.source::text, 'UTF8') || decode('00', 'hex') ||
                convert_to(error_groups.level::text, 'UTF8') || decode('00', 'hex') ||
                convert_to(COALESCE(display_values.display_source_script, ''), 'UTF8') || decode('00', 'hex') ||
                convert_to(display_values.display_message, 'UTF8'),
                'sha256'
            ),
            'hex'
        ) AS display_fingerprint
    FROM error_groups
    JOIN display_values ON display_values.id = error_groups.id
)
UPDATE error_groups
SET display_fingerprint = identities.display_fingerprint,
    display_message = identities.display_message,
    display_source_script = identities.display_source_script
FROM identities
WHERE identities.id = error_groups.id;

ALTER TABLE error_groups
    ALTER COLUMN display_fingerprint SET NOT NULL,
    ALTER COLUMN display_message SET NOT NULL;

CREATE INDEX error_groups_project_display_fingerprint_idx
    ON error_groups (project_id, display_fingerprint);

COMMIT;
