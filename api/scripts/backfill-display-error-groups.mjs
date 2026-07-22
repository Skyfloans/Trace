import pg from "pg";

const batchSize = 1_000;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  let updatedTotal = 0;
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const result = await client.query(`
      WITH candidates AS (
        SELECT id
        FROM error_groups
        WHERE display_fingerprint IS NULL
          AND id > $2::uuid
          AND (
            normalized_message ~ '(^|[^0-9])[0-9]{7,20}([^0-9]|$)'
            OR COALESCE(source_script, '') ~ '(^|[^0-9])[0-9]{7,20}([^0-9]|$)'
          )
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      ), display_values AS (
        SELECT
          error_groups.id,
          regexp_replace(
            normalized_message,
            '(^|[^0-9])([0-9]{7,20})(?=[^0-9]|$)',
            '\\1<ID>',
            'g'
          ) AS display_message,
          source,
          level,
          CASE WHEN source_script IS NULL THEN NULL ELSE regexp_replace(
            source_script,
            '(^|[^0-9])([0-9]{7,20})(?=[^0-9]|$)',
            '\\1<ID>',
            'g'
          ) END AS display_source_script
        FROM error_groups
        JOIN candidates ON candidates.id = error_groups.id
      ), identities AS (
        SELECT
          id,
          display_message,
          display_source_script,
          encode(digest(
            convert_to(source::text, 'UTF8') || decode('00', 'hex') ||
            convert_to(level::text, 'UTF8') || decode('00', 'hex') ||
            convert_to(COALESCE(display_source_script, ''), 'UTF8') || decode('00', 'hex') ||
            convert_to(display_message, 'UTF8'),
            'sha256'
          ), 'hex') AS display_fingerprint
        FROM display_values
      )
      UPDATE error_groups
      SET display_fingerprint = identities.display_fingerprint,
          display_message = identities.display_message,
          display_source_script = identities.display_source_script
      FROM identities
      WHERE identities.id = error_groups.id
      RETURNING error_groups.id
    `, [batchSize, afterId]);

    updatedTotal += result.rowCount ?? 0;
    const ids = result.rows.map((row) => String(row.id)).sort();
    if (ids.length > 0) afterId = ids.at(-1);
    console.log(JSON.stringify({
      updated: result.rowCount ?? 0,
      updatedTotal,
      afterId,
    }));
    if ((result.rowCount ?? 0) < batchSize) break;
  }
} finally {
  await client.end();
}
