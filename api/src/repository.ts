import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { fingerprintEvent } from "./fingerprint.js";
import type { IngestBatch } from "./schema.js";

type IngestResult = {
  accepted: number;
  duplicates: number;
};

export async function findProjectForApiKey(
  pool: Pool,
  apiKey: string,
): Promise<string | null> {
  const keyHash = createHash("sha256").update(apiKey).digest();
  const result = await pool.query<{ project_id: string }>(
    `SELECT project_id
     FROM project_api_keys
     WHERE key_hash = $1
       AND revoked_at IS NULL`,
    [keyHash],
  );

  return result.rows[0]?.project_id ?? null;
}

async function upsertJob(
  client: PoolClient,
  projectId: string,
  batch: IngestBatch,
): Promise<string> {
  if (batch.job.universeId) {
    await client.query(
      `UPDATE projects
       SET roblox_universe_id = COALESCE(roblox_universe_id, $2)
       WHERE id = $1`,
      [projectId, batch.job.universeId],
    );
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO jobs (
       id, project_id, roblox_job_id, place_id, region, release,
       started_at, ended_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (project_id, roblox_job_id) DO UPDATE
     SET region = COALESCE(EXCLUDED.region, jobs.region),
         release = COALESCE(EXCLUDED.release, jobs.release),
         ended_at = COALESCE(EXCLUDED.ended_at, jobs.ended_at),
         last_seen_at = GREATEST(EXCLUDED.last_seen_at, jobs.last_seen_at)
     RETURNING id`,
    [
      batch.job.id,
      projectId,
      batch.job.robloxJobId,
      batch.job.placeId,
      batch.job.region ?? null,
      batch.job.release ?? null,
      batch.job.startedAt,
      batch.job.endedAt ?? null,
      batch.job.lastSeenAt,
    ],
  );

  const jobId = result.rows[0]?.id;
  if (!jobId) {
    throw new Error("Failed to create or update job");
  }

  return jobId;
}

async function upsertSessions(
  client: PoolClient,
  projectId: string,
  jobId: string,
  batch: IngestBatch,
): Promise<void> {
  for (const session of batch.sessions) {
    const result = await client.query(
      `INSERT INTO sessions (
         id, project_id, job_id, player_id, player_name, player_display_name,
         device, platform, started_at, ended_at, last_seen_at, end_reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE
       SET player_name = COALESCE(EXCLUDED.player_name, sessions.player_name),
           player_display_name = COALESCE(
             EXCLUDED.player_display_name,
             sessions.player_display_name
           ),
           device = COALESCE(EXCLUDED.device, sessions.device),
           platform = COALESCE(EXCLUDED.platform, sessions.platform),
           ended_at = COALESCE(EXCLUDED.ended_at, sessions.ended_at),
           last_seen_at = GREATEST(EXCLUDED.last_seen_at, sessions.last_seen_at),
           end_reason = COALESCE(EXCLUDED.end_reason, sessions.end_reason)
       WHERE sessions.project_id = EXCLUDED.project_id
         AND sessions.job_id = EXCLUDED.job_id
       RETURNING id`,
      [
        session.id,
        projectId,
        jobId,
        session.playerId,
        session.playerName ?? null,
        session.playerDisplayName ?? null,
        session.device ?? null,
        session.platform ?? null,
        session.startedAt,
        session.endedAt ?? null,
        session.lastSeenAt,
        session.endReason ?? null,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Session ${session.id} belongs to another project or job`);
    }
  }
}

async function insertEvents(
  client: PoolClient,
  projectId: string,
  jobId: string,
  batch: IngestBatch,
): Promise<IngestResult> {
  let accepted = 0;
  let duplicates = 0;

  for (const event of batch.events) {
    const normalized = fingerprintEvent(event, batch);
    const groupResult = await client.query<{ id: string }>(
      `INSERT INTO error_groups (
         project_id, fingerprint, source, level, source_script,
         normalized_message, normalized_stack,
         first_seen_at, last_seen_at, occurrence_count
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 0)
       ON CONFLICT (project_id, fingerprint) DO UPDATE
       SET source_script = COALESCE(
         error_groups.source_script,
         EXCLUDED.source_script
       )
       RETURNING id`,
      [
        projectId,
        normalized.fingerprint,
        event.source,
        event.level,
        normalized.normalizedSourceScript,
        normalized.normalizedMessage,
        normalized.normalizedStack,
        event.occurredAt,
      ],
    );

    const groupId = groupResult.rows[0]?.id;
    if (!groupId) {
      throw new Error("Failed to create or find error group");
    }

    const occurrenceResult = await client.query(
      `INSERT INTO occurrences (
         id, project_id, group_id, job_id, session_id,
         occurred_at, original_message, original_stack, context
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id, occurred_at) DO NOTHING
       RETURNING id`,
      [
        event.id,
        projectId,
        groupId,
        jobId,
        event.sessionId ?? null,
        event.occurredAt,
        event.message,
        event.stack ?? null,
        event.context ? JSON.stringify(event.context) : null,
      ],
    );

    if (occurrenceResult.rowCount === 0) {
      duplicates += 1;
      continue;
    }

    await client.query(
      `UPDATE error_groups
       SET first_seen_at = LEAST(first_seen_at, $2),
           last_seen_at = GREATEST(last_seen_at, $2),
           occurrence_count = occurrence_count + 1
       WHERE id = $1`,
      [groupId, event.occurredAt],
    );
    accepted += 1;
  }

  return { accepted, duplicates };
}

export async function ingestBatch(
  pool: Pool,
  projectId: string,
  batch: IngestBatch,
): Promise<IngestResult> {
  return withTransaction(pool, async (client) => {
    const jobId = await upsertJob(client, projectId, batch);
    await upsertSessions(client, projectId, jobId, batch);
    return insertEvents(client, projectId, jobId, batch);
  });
}
