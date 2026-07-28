import pg from "pg";

const batchSize = Math.max(
  100,
  Math.min(
    Number(process.env.AI_ERROR_FAMILY_BACKFILL_BATCH_SIZE ?? 10_000),
    50_000,
  ),
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let keyed = 0;

async function activateFamilies(familyKeys) {
  if (familyKeys.length === 0) {
    return { seeded: 0, applied: 0, removed: 0, promoted: 0 };
  }

  const seeded = await client.query(
    `INSERT INTO ai_error_family_classifications (
       family_key,
       category,
       confidence,
       reason,
       classified_at,
       model,
       prompt_version
     )
     SELECT DISTINCT ON (ai_family_key)
       ai_family_key,
       ai_category,
       ai_confidence,
       ai_reason,
       ai_classified_at,
       ai_model,
       ai_prompt_version
     FROM display_error_groups
     WHERE ai_family_key = ANY($1::text[])
       AND ai_status = 'classified'
       AND ai_category IS NOT NULL
       AND ai_confidence IS NOT NULL
       AND ai_reason IS NOT NULL
       AND ai_classified_at IS NOT NULL
       AND ai_model IS NOT NULL
       AND ai_prompt_version IS NOT NULL
     ORDER BY ai_family_key, ai_classified_at DESC, id
     ON CONFLICT (family_key) DO UPDATE
     SET category = EXCLUDED.category,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason,
         classified_at = EXCLUDED.classified_at,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version
     WHERE ai_error_family_classifications.classified_at
           < EXCLUDED.classified_at`,
    [familyKeys],
  );

  const applied = await client.query(
    `UPDATE display_error_groups groups
     SET ai_category = cached.category,
         ai_confidence = cached.confidence,
         ai_reason = cached.reason,
         ai_classified_at = cached.classified_at,
         ai_model = cached.model,
         ai_prompt_version = cached.prompt_version,
         ai_status = 'classified'
     FROM ai_error_family_classifications cached
     WHERE groups.ai_family_key = ANY($1::text[])
       AND groups.ai_family_key = cached.family_key
       AND (
         groups.ai_status <> 'classified'
         OR groups.ai_prompt_version < cached.prompt_version
       )`,
    [familyKeys],
  );

  await client.query(
    `UPDATE display_error_rollups_hourly rollups
     SET ai_category = cached.category
     FROM display_error_groups groups
     JOIN ai_error_family_classifications cached
       ON cached.family_key = groups.ai_family_key
     WHERE groups.ai_family_key = ANY($1::text[])
       AND rollups.display_group_id = groups.id
       AND rollups.ai_category IS DISTINCT FROM cached.category`,
    [familyKeys],
  );

  const removed = await client.query(
    `DELETE FROM ai_classification_jobs jobs
     USING display_error_groups groups,
           ai_error_family_classifications cached
     WHERE jobs.target_type = 'error'
       AND jobs.target_id = groups.id
       AND groups.ai_family_key = ANY($1::text[])
       AND groups.ai_family_key = cached.family_key`,
    [familyKeys],
  );

  const promoted = await client.query(
    `WITH representatives AS MATERIALIZED (
       SELECT DISTINCT ON (groups.ai_family_key)
         jobs.target_id
       FROM ai_classification_jobs jobs
       JOIN display_error_groups groups
         ON jobs.target_type = 'error'
        AND groups.id = jobs.target_id
       LEFT JOIN ai_error_family_classifications cached
         ON cached.family_key = groups.ai_family_key
       WHERE jobs.status = 'pending'
         AND jobs.priority > 0
         AND groups.ai_family_key = ANY($1::text[])
         AND groups.ai_status <> 'classified'
         AND cached.family_key IS NULL
       ORDER BY
         groups.ai_family_key,
         jobs.priority DESC,
         groups.last_seen_at DESC,
         jobs.target_id
     )
     UPDATE ai_classification_jobs jobs
     SET priority = 10,
         available_at = LEAST(jobs.available_at, now())
     FROM representatives
     WHERE jobs.target_type = 'error'
       AND jobs.target_id = representatives.target_id
       AND jobs.priority < 10`,
    [familyKeys],
  );

  return {
    seeded: seeded.rowCount ?? 0,
    applied: applied.rowCount ?? 0,
    removed: removed.rowCount ?? 0,
    promoted: promoted.rowCount ?? 0,
  };
}

try {
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '5min'");

  while (true) {
    const result = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT groups.id
         FROM display_error_groups groups
         WHERE groups.ai_family_key IS NULL
           AND (
             groups.ai_status = 'classified'
             OR EXISTS (
               SELECT 1
               FROM ai_classification_jobs jobs
               WHERE jobs.target_type = 'error'
                 AND jobs.target_id = groups.id
                 AND jobs.priority > 0
             )
           )
         ORDER BY groups.id
         LIMIT $1
       )
       UPDATE display_error_groups groups
       SET ai_family_key = ai_error_family_key(
             groups.source::text,
             groups.level::text,
             groups.normalized_message
           )
       FROM candidates
       WHERE groups.id = candidates.id
       RETURNING groups.ai_family_key`,
      [batchSize],
    );
    const count = result.rowCount ?? 0;
    keyed += count;
    const familyKeys = [...new Set(
      result.rows.map((row) => String(row.ai_family_key)),
    )];
    const activation = await activateFamilies(familyKeys);
    console.log(JSON.stringify({
      phase: "family_keys",
      count,
      keyed,
      families: familyKeys.length,
      ...activation,
    }));
    if (count < batchSize) break;
  }

  const seeded = await client.query(
    `INSERT INTO ai_error_family_classifications (
       family_key,
       category,
       confidence,
       reason,
       classified_at,
       model,
       prompt_version
     )
     SELECT DISTINCT ON (ai_family_key)
       ai_family_key,
       ai_category,
       ai_confidence,
       ai_reason,
       ai_classified_at,
       ai_model,
       ai_prompt_version
     FROM display_error_groups
     WHERE ai_family_key IS NOT NULL
       AND ai_status = 'classified'
       AND ai_category IS NOT NULL
       AND ai_confidence IS NOT NULL
       AND ai_reason IS NOT NULL
       AND ai_classified_at IS NOT NULL
       AND ai_model IS NOT NULL
       AND ai_prompt_version IS NOT NULL
     ORDER BY ai_family_key, ai_classified_at DESC, id
     ON CONFLICT (family_key) DO UPDATE
     SET category = EXCLUDED.category,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason,
         classified_at = EXCLUDED.classified_at,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version
     WHERE ai_error_family_classifications.classified_at
           < EXCLUDED.classified_at`,
  );

  const applied = await client.query(
    `UPDATE display_error_groups groups
     SET ai_category = cached.category,
         ai_confidence = cached.confidence,
         ai_reason = cached.reason,
         ai_classified_at = cached.classified_at,
         ai_model = cached.model,
         ai_prompt_version = cached.prompt_version,
         ai_status = 'classified'
     FROM ai_error_family_classifications cached
     WHERE groups.ai_family_key = cached.family_key
       AND (
         groups.ai_status <> 'classified'
         OR groups.ai_prompt_version < cached.prompt_version
       )`,
  );

  await client.query(
    `UPDATE display_error_rollups_hourly rollups
     SET ai_category = cached.category
     FROM display_error_groups groups
     JOIN ai_error_family_classifications cached
       ON cached.family_key = groups.ai_family_key
     WHERE rollups.display_group_id = groups.id
       AND rollups.ai_category IS DISTINCT FROM cached.category`,
  );

  const removedCachedJobs = await client.query(
    `DELETE FROM ai_classification_jobs jobs
     USING display_error_groups groups,
           ai_error_family_classifications cached
     WHERE jobs.target_type = 'error'
       AND jobs.target_id = groups.id
       AND groups.ai_family_key = cached.family_key`,
  );

  const promoted = await client.query(
    `WITH representatives AS MATERIALIZED (
       SELECT DISTINCT ON (groups.ai_family_key)
         jobs.target_id
       FROM ai_classification_jobs jobs
       JOIN display_error_groups groups
         ON jobs.target_type = 'error'
        AND groups.id = jobs.target_id
       LEFT JOIN ai_error_family_classifications cached
         ON cached.family_key = groups.ai_family_key
       WHERE jobs.status = 'pending'
         AND jobs.priority > 0
         AND groups.ai_family_key IS NOT NULL
         AND groups.ai_status <> 'classified'
         AND cached.family_key IS NULL
       ORDER BY
         groups.ai_family_key,
         groups.last_seen_at DESC,
         jobs.target_id
     )
     UPDATE ai_classification_jobs jobs
     SET priority = 10,
         available_at = LEAST(jobs.available_at, now())
     FROM representatives
     WHERE jobs.target_type = 'error'
       AND jobs.target_id = representatives.target_id
       AND jobs.priority < 10`,
  );

  const status = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE target_type = 'error' AND priority >= 10
       )::bigint AS ready_error_families,
       COUNT(*) FILTER (
         WHERE target_type = 'error' AND priority < 10
       )::bigint AS dormant_family_members
     FROM ai_classification_jobs`,
  );

  console.log(JSON.stringify({
    phase: "complete",
    keyed,
    seededFamilies: seeded.rowCount ?? 0,
    appliedGroups: applied.rowCount ?? 0,
    removedCachedJobs: removedCachedJobs.rowCount ?? 0,
    promotedFamilies: promoted.rowCount ?? 0,
    ...status.rows[0],
  }));
} finally {
  await client.end();
}
