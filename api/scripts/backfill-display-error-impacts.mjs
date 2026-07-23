import pg from "pg";

const hoursPerBatch = Number(process.env.DISPLAY_IMPACT_BATCH_HOURS ?? 1);
const requestedStart = process.env.DISPLAY_IMPACT_START_AT
  ? new Date(process.env.DISPLAY_IMPACT_START_AT)
  : null;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const bounds = await client.query(`
    SELECT
      GREATEST(
        date_trunc('hour', COALESCE(MIN(occurred_at), now())),
        date_trunc('hour', now() - interval '3 days')
      ) AS first_bucket,
      now() AS finished_at
    FROM occurrences
    WHERE occurred_at >= now() - interval '3 days'
  `);
  let cursor = new Date(bounds.rows[0].first_bucket);
  const finishedAt = new Date(bounds.rows[0].finished_at);
  if (requestedStart) {
    if (Number.isNaN(requestedStart.getTime())) {
      throw new Error("DISPLAY_IMPACT_START_AT must be an ISO timestamp");
    }
    cursor = new Date(Math.max(cursor.getTime(), requestedStart.getTime()));
  }
  let playerRows = 0;
  let jobRows = 0;

  while (cursor < finishedAt) {
    const next = new Date(Math.min(
      cursor.getTime() + hoursPerBatch * 60 * 60 * 1_000,
      finishedAt.getTime(),
    ));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await client.query("BEGIN");
      try {
        const players = await client.query(`
          INSERT INTO display_error_group_players (
            project_id, display_group_id, player_id, last_seen_at
          )
          SELECT
            occurrences.project_id,
            members.display_group_id,
            sessions.player_id,
            MAX(occurrences.occurred_at)
          FROM occurrences
          JOIN display_error_group_members members
            ON members.exact_group_id = occurrences.group_id
          JOIN sessions ON sessions.id = occurrences.session_id
          WHERE occurrences.occurred_at >= $1
            AND occurrences.occurred_at < $2
            AND sessions.player_id IS NOT NULL
          GROUP BY
            occurrences.project_id,
            members.display_group_id,
            sessions.player_id
          ORDER BY
            occurrences.project_id,
            members.display_group_id,
            sessions.player_id
          ON CONFLICT (project_id, display_group_id, player_id) DO UPDATE
          SET last_seen_at = GREATEST(
            display_error_group_players.last_seen_at,
            EXCLUDED.last_seen_at
          )
        `, [cursor, next]);
        const jobs = await client.query(`
          INSERT INTO display_error_group_jobs (
            project_id, display_group_id, job_id, last_seen_at
          )
          SELECT
            occurrences.project_id,
            members.display_group_id,
            occurrences.job_id,
            MAX(occurrences.occurred_at)
          FROM occurrences
          JOIN display_error_group_members members
            ON members.exact_group_id = occurrences.group_id
          WHERE occurrences.occurred_at >= $1
            AND occurrences.occurred_at < $2
          GROUP BY
            occurrences.project_id,
            members.display_group_id,
            occurrences.job_id
          ORDER BY
            occurrences.project_id,
            members.display_group_id,
            occurrences.job_id
          ON CONFLICT (project_id, display_group_id, job_id) DO UPDATE
          SET last_seen_at = GREATEST(
            display_error_group_jobs.last_seen_at,
            EXCLUDED.last_seen_at
          )
        `, [cursor, next]);
        await client.query("COMMIT");
        playerRows += Number(players.rowCount ?? 0);
        jobRows += Number(jobs.rowCount ?? 0);
        break;
      } catch (error) {
        await client.query("ROLLBACK");
        if (error?.code !== "40P01" || attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    console.log(JSON.stringify({
      from: cursor.toISOString(),
      to: next.toISOString(),
      playerRows,
      jobRows,
    }));
    cursor = next;
  }

  const verification = await client.query(`
    WITH expected_players AS (
      SELECT DISTINCT
        occurrences.project_id,
        members.display_group_id,
        sessions.player_id
      FROM occurrences
      JOIN display_error_group_members members
        ON members.exact_group_id = occurrences.group_id
      JOIN sessions ON sessions.id = occurrences.session_id
      WHERE occurrences.occurred_at >= now() - interval '3 days'
        AND sessions.player_id IS NOT NULL
    ), expected_jobs AS (
      SELECT DISTINCT
        occurrences.project_id,
        members.display_group_id,
        occurrences.job_id
      FROM occurrences
      JOIN display_error_group_members members
        ON members.exact_group_id = occurrences.group_id
      WHERE occurrences.occurred_at >= now() - interval '3 days'
    )
    SELECT
      (SELECT COUNT(*)
       FROM expected_players expected
       WHERE NOT EXISTS (
         SELECT 1
         FROM display_error_group_players actual
         WHERE actual.project_id = expected.project_id
           AND actual.display_group_id = expected.display_group_id
           AND actual.player_id = expected.player_id
       ))::bigint AS missing_players,
      (SELECT COUNT(*)
       FROM expected_jobs expected
       WHERE NOT EXISTS (
         SELECT 1
         FROM display_error_group_jobs actual
         WHERE actual.project_id = expected.project_id
           AND actual.display_group_id = expected.display_group_id
           AND actual.job_id = expected.job_id
       ))::bigint AS missing_jobs
  `);
  const totals = verification.rows[0];
  if (
    String(totals.missing_players) !== "0"
    || String(totals.missing_jobs) !== "0"
  ) {
    throw new Error(`Display impact verification failed: ${JSON.stringify(totals)}`);
  }

  await client.query(`
    INSERT INTO trace_read_model_state (key)
    VALUES ('display_error_impacts_v1')
    ON CONFLICT (key) DO UPDATE SET ready_at = now()
  `);
  console.log(JSON.stringify({ ready: true, ...totals, playerRows, jobRows }));
} finally {
  await client.end();
}
