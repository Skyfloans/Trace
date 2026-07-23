import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '10min'");

  const seeded = await client.query(`
    INSERT INTO ai_error_classifications (
      fingerprint,
      category,
      confidence,
      reason,
      classified_at,
      model,
      prompt_version
    )
    SELECT DISTINCT ON (fingerprint)
      fingerprint,
      ai_category,
      ai_confidence,
      ai_reason,
      ai_classified_at,
      ai_model,
      ai_prompt_version
    FROM display_error_groups
    WHERE ai_status = 'classified'
      AND ai_category IS NOT NULL
      AND ai_confidence IS NOT NULL
      AND ai_reason IS NOT NULL
      AND ai_classified_at IS NOT NULL
      AND ai_model IS NOT NULL
      AND ai_prompt_version IS NOT NULL
    ORDER BY fingerprint, ai_classified_at DESC, id
    ON CONFLICT (fingerprint) DO UPDATE
    SET category = EXCLUDED.category,
        confidence = EXCLUDED.confidence,
        reason = EXCLUDED.reason,
        classified_at = EXCLUDED.classified_at,
        model = EXCLUDED.model,
        prompt_version = EXCLUDED.prompt_version
    WHERE ai_error_classifications.classified_at
          < EXCLUDED.classified_at
  `);

  await client.query(`
    UPDATE ai_classification_jobs
    SET status = 'pending',
        locked_at = NULL,
        locked_by = NULL
    WHERE target_type = 'error'
      AND priority = 0
      AND status = 'processing'
  `);

  await client.query("BEGIN");
  await client.query(`
    CREATE TEMP TABLE ai_error_queue_canonical (
      target_id UUID PRIMARY KEY
    ) ON COMMIT DROP
  `);
  const canonical = await client.query(`
    INSERT INTO ai_error_queue_canonical (target_id)
    SELECT DISTINCT ON (groups.fingerprint)
      jobs.target_id
    FROM display_error_groups groups
    JOIN ai_classification_jobs jobs
      ON jobs.target_type = 'error'
     AND jobs.target_id = groups.id
    WHERE groups.last_seen_at >= now() - interval '3 days'
      AND groups.level IN ('error', 'warning')
      AND groups.ai_status <> 'classified'
      AND jobs.status = 'pending'
    ORDER BY
      groups.fingerprint,
      jobs.priority DESC,
      groups.last_seen_at DESC,
      jobs.target_id
  `);
  await client.query(`
    UPDATE ai_classification_jobs jobs
    SET priority = 1,
        available_at = LEAST(available_at, now())
    FROM ai_error_queue_canonical canonical
    WHERE jobs.target_type = 'error'
      AND jobs.target_id = canonical.target_id
      AND jobs.status = 'pending'
      AND jobs.priority = 0
  `);
  await client.query("COMMIT");

  let removedStale = 0;
  while (true) {
    const removed = await client.query(`
      WITH stale AS (
        SELECT jobs.ctid
        FROM ai_classification_jobs jobs
        LEFT JOIN display_error_groups groups
          ON jobs.target_type = 'error'
         AND groups.id = jobs.target_id
        WHERE jobs.target_type = 'error'
          AND jobs.status = 'pending'
          AND (
            groups.id IS NULL
            OR groups.last_seen_at < now() - interval '3 days'
            OR groups.level NOT IN ('error', 'warning')
            OR groups.ai_status = 'classified'
          )
        LIMIT 10000
      )
      DELETE FROM ai_classification_jobs jobs
      USING stale
      WHERE jobs.ctid = stale.ctid
    `);
    const count = removed.rowCount ?? 0;
    removedStale += count;
    if (count < 10000) break;
  }

  const status = await client.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE target_type = 'error' AND priority > 0
      )::bigint AS canonical_error_jobs,
      COUNT(*) FILTER (
        WHERE target_type = 'error' AND priority = 0
      )::bigint AS dormant_duplicate_error_jobs,
      COUNT(*) FILTER (
        WHERE target_type = 'feedback'
      )::bigint AS feedback_jobs
    FROM ai_classification_jobs
  `);
  console.log(JSON.stringify({
    cacheRowsSeeded: seeded.rowCount ?? 0,
    canonicalFingerprints: canonical.rowCount ?? 0,
    removedStale,
    ...status.rows[0],
  }));
} finally {
  await client.end();
}
