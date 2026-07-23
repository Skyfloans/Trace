import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { fingerprintEvent } from "./fingerprint.js";
import type { IngestBatch, IngestEvent } from "./schema.js";

type IngestResult = {
  accepted: number;
  duplicates: number;
};

type CachedProject = {
  expiresAt: number;
  projectId: string;
};

type CachedUniverseVerification = {
  expiresAt: number;
  matches: boolean;
};

type IngestionAuthCache = {
  projects: Map<string, CachedProject>;
  loads: Map<string, Promise<string | null>>;
  universes: Map<string, CachedUniverseVerification>;
  universeLoads: Map<string, Promise<boolean>>;
};

const INGESTION_AUTH_CACHE_MS = 15_000;
const UNIVERSE_VERIFICATION_CACHE_MS = 5 * 60_000;
const FAILED_UNIVERSE_VERIFICATION_CACHE_MS = 10_000;
const ingestionAuthCaches = new WeakMap<Pool, IngestionAuthCache>();

export function compactOccurrenceContext(
  context: IngestEvent["context"],
): Record<string, unknown> | null {
  if (!context) return null;

  const compact = Object.fromEntries(
    Object.entries(context).filter(
      ([key]) => key !== "clientReported" && key !== "device",
    ),
  );
  return Object.keys(compact).length > 0 ? compact : null;
}

function getIngestionAuthCache(pool: Pool): IngestionAuthCache {
  const existing = ingestionAuthCaches.get(pool);
  if (existing) return existing;

  const created = {
    projects: new Map<string, CachedProject>(),
    loads: new Map<string, Promise<string | null>>(),
    universes: new Map<string, CachedUniverseVerification>(),
    universeLoads: new Map<string, Promise<boolean>>(),
  };
  ingestionAuthCaches.set(pool, created);
  return created;
}

export async function findProjectForApiKey(
  pool: Pool,
  apiKey: string,
): Promise<string | null> {
  const keyHash = createHash("sha256").update(apiKey).digest();
  const cacheKey = keyHash.toString("hex");
  const cache = getIngestionAuthCache(pool);
  const cached = cache.projects.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.projectId;
  if (cached) cache.projects.delete(cacheKey);

  const pending = cache.loads.get(cacheKey);
  if (pending) return pending;

  const load = pool
    .query<{ project_id: string }>(
      `SELECT project_id
       FROM project_api_keys
       WHERE key_hash = $1
         AND revoked_at IS NULL`,
      [keyHash],
    )
    .then((result) => {
      const projectId = result.rows[0]?.project_id ?? null;
      if (projectId) {
        cache.projects.set(cacheKey, {
          expiresAt: Date.now() + INGESTION_AUTH_CACHE_MS,
          projectId,
        });
      }
      return projectId;
    })
    .finally(() => cache.loads.delete(cacheKey));

  cache.loads.set(cacheKey, load);
  return load;
}

export async function verifyProjectUniverse(
  pool: Pool,
  projectId: string,
  universeId: string,
): Promise<boolean> {
  const cache = getIngestionAuthCache(pool);
  const cacheKey = `${projectId}:${universeId}`;
  const cached = cache.universes.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.matches;
  if (cached) cache.universes.delete(cacheKey);

  const pending = cache.universeLoads.get(cacheKey);
  if (pending) return pending;

  const load = pool
    .query<{ matches: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM projects
         WHERE id = $1 AND roblox_universe_id = $2
       ) AS matches`,
      [projectId, universeId],
    )
    .then((result) => {
      const matches = result.rows[0]?.matches ?? false;
      cache.universes.set(cacheKey, {
        expiresAt:
          Date.now() +
          (matches
            ? UNIVERSE_VERIFICATION_CACHE_MS
            : FAILED_UNIVERSE_VERIFICATION_CACHE_MS),
        matches,
      });
      return matches;
    })
    .finally(() => cache.universeLoads.delete(cacheKey));

  cache.universeLoads.set(cacheKey, load);
  return load;
}

async function upsertJob(
  client: PoolClient,
  projectId: string,
  batch: IngestBatch,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `WITH project_update AS (
       UPDATE projects
       SET roblox_universe_id = COALESCE(roblox_universe_id, $10)
       WHERE id = $2
         AND roblox_universe_id IS NULL
         AND $10::text IS NOT NULL
       RETURNING id
     ), upserted AS (
     INSERT INTO jobs (
       id, project_id, roblox_job_id, place_id, region, release,
       started_at, ended_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (project_id, roblox_job_id) DO UPDATE
     SET region = COALESCE(EXCLUDED.region, jobs.region),
         release = COALESCE(EXCLUDED.release, jobs.release),
         ended_at = COALESCE(EXCLUDED.ended_at, jobs.ended_at),
         last_seen_at = GREATEST(EXCLUDED.last_seen_at, jobs.last_seen_at)
     WHERE jobs.region IS DISTINCT FROM COALESCE(EXCLUDED.region, jobs.region)
        OR jobs.release IS DISTINCT FROM COALESCE(EXCLUDED.release, jobs.release)
        OR jobs.ended_at IS DISTINCT FROM COALESCE(EXCLUDED.ended_at, jobs.ended_at)
        OR jobs.last_seen_at < EXCLUDED.last_seen_at
     RETURNING id
     )
     SELECT id FROM upserted
     UNION ALL
     SELECT id FROM jobs
     WHERE project_id = $2 AND roblox_job_id = $3
     LIMIT 1`,
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
      batch.job.universeId ?? null,
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
  if (batch.sessions.length === 0) {
    return;
  }

  const result = await client.query<{ matched_count: number }>(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($3::jsonb) AS session_input(
         id uuid, player_id bigint, player_name text,
         player_display_name text, device text, platform text,
         started_at timestamptz, ended_at timestamptz,
         last_seen_at timestamptz, end_reason text
       )
     ),
     upserted AS (
     INSERT INTO sessions (
       id, project_id, job_id, player_id, player_name, player_display_name,
       device, platform, started_at, ended_at, last_seen_at, end_reason
     )
     SELECT
       input.id, $1, $2, input.player_id, input.player_name,
       input.player_display_name, input.device, input.platform,
       input.started_at, input.ended_at, input.last_seen_at, input.end_reason
     FROM input
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
       AND (
         sessions.player_name IS DISTINCT FROM COALESCE(EXCLUDED.player_name, sessions.player_name)
         OR sessions.player_display_name IS DISTINCT FROM COALESCE(
           EXCLUDED.player_display_name,
           sessions.player_display_name
         )
         OR sessions.device IS DISTINCT FROM COALESCE(EXCLUDED.device, sessions.device)
         OR sessions.platform IS DISTINCT FROM COALESCE(EXCLUDED.platform, sessions.platform)
         OR sessions.ended_at IS DISTINCT FROM COALESCE(EXCLUDED.ended_at, sessions.ended_at)
         OR sessions.last_seen_at < EXCLUDED.last_seen_at
         OR sessions.end_reason IS DISTINCT FROM COALESCE(EXCLUDED.end_reason, sessions.end_reason)
       )
     RETURNING id
     )
     SELECT COUNT(*) FILTER (
       WHERE upserted.id IS NOT NULL OR existing.id IS NOT NULL
     )::int AS matched_count
     FROM input
     LEFT JOIN upserted ON upserted.id = input.id
     LEFT JOIN sessions existing
       ON existing.id = input.id
      AND existing.project_id = $1
      AND existing.job_id = $2`,
    [
      projectId,
      jobId,
      JSON.stringify(
        batch.sessions.map((session) => ({
          id: session.id,
          player_id: session.playerId,
          player_name: session.playerName ?? null,
          player_display_name: session.playerDisplayName ?? null,
          device: session.device ?? null,
          platform: session.platform ?? null,
          started_at: session.startedAt,
          ended_at: session.endedAt ?? null,
          last_seen_at: session.lastSeenAt,
          end_reason: session.endReason ?? null,
        })),
      ),
    ],
  );

  if (result.rows[0]?.matched_count !== batch.sessions.length) {
    throw new Error("A session belongs to another project or job");
  }
}

async function insertEvents(
  client: PoolClient,
  projectId: string,
  jobId: string,
  batch: IngestBatch,
): Promise<IngestResult> {
  if (batch.events.length === 0) {
    return { accepted: 0, duplicates: 0 };
  }

  const normalizedEvents = batch.events.map((event) => ({
    event,
    normalized: fingerprintEvent(event, batch),
  }));
  const groups = new Map<
    string,
    {
      fingerprint: string;
      source: string;
      level: string;
      sourceScript: string | null;
      normalizedMessage: string;
      normalizedStack: string | null;
      displayFingerprint: string;
      displayMessage: string;
      displaySourceScript: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();

  for (const { event, normalized } of normalizedEvents) {
    const lastSeenAt = event.lastOccurredAt ?? event.occurredAt;
    const existing = groups.get(normalized.fingerprint);
    if (existing) {
      if (event.occurredAt < existing.firstSeenAt) {
        existing.firstSeenAt = event.occurredAt;
      }
      if (lastSeenAt > existing.lastSeenAt) {
        existing.lastSeenAt = lastSeenAt;
      }
      continue;
    }
    groups.set(normalized.fingerprint, {
      fingerprint: normalized.fingerprint,
      source: event.source,
      level: event.level,
      sourceScript: normalized.normalizedSourceScript,
      normalizedMessage: normalized.normalizedMessage,
      normalizedStack: normalized.normalizedStack,
      displayFingerprint: normalized.displayFingerprint,
      displayMessage: normalized.displayMessage,
      displaySourceScript: normalized.displaySourceScript,
      firstSeenAt: event.occurredAt,
      lastSeenAt,
    });
  }

  const groupInputs = [...groups.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  const groupInputJson = JSON.stringify(
    groupInputs.map((group) => ({
      fingerprint: group.fingerprint,
      source: group.source,
      level: group.level,
      source_script: group.sourceScript,
      normalized_message: group.normalizedMessage,
      normalized_stack: group.normalizedStack,
      display_fingerprint: group.displayFingerprint,
      display_message: group.displayMessage,
      display_source_script: group.displaySourceScript,
      first_seen_at: group.firstSeenAt,
      last_seen_at: group.lastSeenAt,
    })),
  );

  // Different Roblox servers frequently report the same group set and hour.
  // Lock each exact group and display-group/hour pair in deterministic order so
  // the online backfill cannot lose increments without serializing a project.
  await client.query(
    `SELECT pg_advisory_xact_lock(locks.lock_key)
     FROM (
       SELECT hashtextextended(
         $1::text || ':' || input.fingerprint,
         0
       ) AS lock_key
       FROM jsonb_to_recordset($2::jsonb) AS input(fingerprint text)
       UNION
       SELECT hashtextextended(
         'display-rollup:' || $1::text || ':' ||
         to_char(
           date_trunc('hour', event.occurred_at AT TIME ZONE 'UTC'),
           'YYYY-MM-DD"T"HH24'
         ) || ':' || event.display_fingerprint,
         0
       ) AS lock_key
       FROM jsonb_to_recordset($3::jsonb) AS event(
         occurred_at timestamptz,
         display_fingerprint text
       )
     ) locks
     ORDER BY locks.lock_key`,
    [
      projectId,
      groupInputJson,
      JSON.stringify(
        normalizedEvents.map(({ event, normalized }) => ({
          occurred_at: event.occurredAt,
          display_fingerprint: normalized.displayFingerprint,
        })),
      ),
    ],
  );

  const groupResult = await client.query<{
    id: string;
    fingerprint: string;
    display_group_id: string;
  }>(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($2::jsonb) AS item(
         fingerprint text, source text, level text, source_script text,
         normalized_message text, normalized_stack text,
         display_fingerprint text, display_message text,
         display_source_script text,
         first_seen_at timestamptz, last_seen_at timestamptz
       )
     ), exact_upserted AS (
     INSERT INTO error_groups (
       project_id, fingerprint, source, level, source_script,
       normalized_message, normalized_stack, display_fingerprint,
       display_message, display_source_script,
       first_seen_at, last_seen_at, occurrence_count
     )
     SELECT
       $1, input.fingerprint, input.source::log_source, input.level::log_level,
       input.source_script, input.normalized_message, input.normalized_stack,
       input.display_fingerprint, input.display_message,
       input.display_source_script,
       input.first_seen_at, input.last_seen_at, 0
     FROM input
     ORDER BY input.fingerprint
     ON CONFLICT (project_id, fingerprint) DO UPDATE
     SET source_script = COALESCE(
       error_groups.source_script,
       EXCLUDED.source_script
     ),
         normalized_stack = COALESCE(
           error_groups.normalized_stack,
           EXCLUDED.normalized_stack
         )
     WHERE (error_groups.source_script IS NULL AND EXCLUDED.source_script IS NOT NULL)
        OR (error_groups.normalized_stack IS NULL AND EXCLUDED.normalized_stack IS NOT NULL)
     RETURNING id, fingerprint
     ), exact_groups AS (
       SELECT id, fingerprint FROM exact_upserted
       UNION
       SELECT groups.id, groups.fingerprint
       FROM error_groups groups
       JOIN input ON input.fingerprint = groups.fingerprint
       WHERE groups.project_id = $1
     ), display_input AS (
       SELECT
         display_fingerprint AS fingerprint,
         level,
         source,
         display_message AS normalized_message,
         display_source_script AS source_script,
         MIN(first_seen_at) AS first_seen_at,
         MAX(last_seen_at) AS last_seen_at
       FROM input
       GROUP BY
         display_fingerprint,
         level,
         source,
         display_message,
         display_source_script
     ), display_upserted AS (
       INSERT INTO display_error_groups (
         project_id, fingerprint, level, source, normalized_message,
         source_script, first_seen_at, last_seen_at
       )
       SELECT
         $1,
         display_input.fingerprint,
         display_input.level::log_level,
         display_input.source::log_source,
         display_input.normalized_message,
         display_input.source_script,
         display_input.first_seen_at,
         display_input.last_seen_at
       FROM display_input
       ORDER BY display_input.fingerprint
       ON CONFLICT (project_id, fingerprint) DO UPDATE
       SET first_seen_at = LEAST(
             display_error_groups.first_seen_at,
             EXCLUDED.first_seen_at
           ),
           last_seen_at = GREATEST(
             display_error_groups.last_seen_at,
             EXCLUDED.last_seen_at
           ),
           source_script = COALESCE(
             display_error_groups.source_script,
             EXCLUDED.source_script
           )
       RETURNING id, fingerprint
     ), display_groups AS (
       SELECT id, fingerprint FROM display_upserted
       UNION
       SELECT groups.id, groups.fingerprint
       FROM display_error_groups groups
       JOIN display_input ON display_input.fingerprint = groups.fingerprint
       WHERE groups.project_id = $1
     ), members AS (
       INSERT INTO display_error_group_members (
         exact_group_id,
         display_group_id
       )
       SELECT exact_groups.id, display_groups.id
       FROM input
       JOIN exact_groups ON exact_groups.fingerprint = input.fingerprint
       JOIN display_groups
         ON display_groups.fingerprint = input.display_fingerprint
       ON CONFLICT (exact_group_id) DO UPDATE
       SET display_group_id = EXCLUDED.display_group_id
       RETURNING exact_group_id, display_group_id
     )
     SELECT
       exact_groups.id,
       exact_groups.fingerprint,
       members.display_group_id
     FROM exact_groups
     JOIN members ON members.exact_group_id = exact_groups.id`,
    [projectId, groupInputJson],
  );
  const groupIds = new Map(
    groupResult.rows.map((row) => [
      row.fingerprint,
      { exactGroupId: row.id, displayGroupId: row.display_group_id },
    ]),
  );
  const occurrences = normalizedEvents.map(({ event, normalized }) => {
    const groupsForEvent = groupIds.get(normalized.fingerprint);
    if (!groupsForEvent) {
      throw new Error("Failed to create or find error group");
    }
    return {
      id: event.id,
      group_id: groupsForEvent.exactGroupId,
      display_group_id: groupsForEvent.displayGroupId,
      session_id: event.sessionId ?? null,
      occurred_at: event.occurredAt,
      last_occurred_at: event.lastOccurredAt ?? event.occurredAt,
      repeat_count: event.repeatCount,
      original_message:
        event.message === normalized.normalizedMessage ? null : event.message,
      original_stack:
        event.stack === normalized.normalizedStack ? null : (event.stack ?? null),
      context: compactOccurrenceContext(event.context),
    };
  });
  const logicalEventCount = occurrences.reduce(
    (total, event) => total + event.repeat_count,
    0,
  );

  const result = await client.query<{ accepted: number }>(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($3::jsonb) AS event(
         id uuid, group_id uuid, display_group_id uuid, session_id uuid,
         occurred_at timestamptz,
         last_occurred_at timestamptz, repeat_count integer,
         original_message text, original_stack text, context jsonb
       )
     ),
     inserted AS (
       INSERT INTO occurrences (
         id, project_id, group_id, display_group_id, job_id, session_id,
         occurred_at, last_occurred_at, repeat_count,
         original_message, original_stack, context
       )
       SELECT
         id, $1, group_id, display_group_id, $2, session_id,
         occurred_at, last_occurred_at, repeat_count,
         original_message, original_stack, context
       FROM input
       ON CONFLICT (id, occurred_at) DO NOTHING
       RETURNING
         id, group_id, display_group_id, session_id, occurred_at,
         last_occurred_at, repeat_count, original_message
     ),
     totals AS (
       SELECT
         group_id,
         MIN(occurred_at) AS first_seen_at,
         MAX(last_occurred_at) AS last_seen_at,
         SUM(repeat_count)::bigint AS occurrence_count
       FROM inserted
       GROUP BY group_id
     ),
     live_rollups AS (
       INSERT INTO occurrence_rollups_hourly (
         project_id, group_id, bucket_at, event_count,
         affected_player_count, affected_server_count,
         first_seen_at, last_seen_at
       )
       SELECT
         $1,
         inserted.group_id,
         date_trunc('hour', inserted.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
         SUM(inserted.repeat_count)::bigint,
         COUNT(DISTINCT sessions.player_id)::int,
         1,
         MIN(inserted.occurred_at),
         MAX(COALESCE(inserted.last_occurred_at, inserted.occurred_at))
       FROM inserted
       LEFT JOIN sessions ON sessions.id = inserted.session_id
       GROUP BY inserted.group_id, 3
       ON CONFLICT (project_id, group_id, bucket_at) DO UPDATE
       SET event_count = occurrence_rollups_hourly.event_count + EXCLUDED.event_count,
           affected_player_count = GREATEST(
             occurrence_rollups_hourly.affected_player_count,
             EXCLUDED.affected_player_count
           ),
           affected_server_count = GREATEST(
             occurrence_rollups_hourly.affected_server_count,
             EXCLUDED.affected_server_count
           ),
           first_seen_at = LEAST(
             occurrence_rollups_hourly.first_seen_at,
             EXCLUDED.first_seen_at
           ),
           last_seen_at = GREATEST(
             occurrence_rollups_hourly.last_seen_at,
             EXCLUDED.last_seen_at
           )
       RETURNING group_id
     ), display_live_rollups AS (
       INSERT INTO display_error_rollups_hourly (
         project_id, display_group_id, bucket_at, event_count,
         first_seen_at, last_seen_at, level, source
       )
       SELECT
         $1,
         input.display_group_id,
         date_trunc(
           'hour',
           inserted.occurred_at AT TIME ZONE 'UTC'
         ) AT TIME ZONE 'UTC',
         SUM(inserted.repeat_count)::bigint,
         MIN(inserted.occurred_at),
         MAX(COALESCE(inserted.last_occurred_at, inserted.occurred_at)),
         display_rollup_group.level,
         display_rollup_group.source
       FROM inserted
       JOIN input
         ON input.id = inserted.id
        AND input.occurred_at = inserted.occurred_at
       JOIN display_error_groups display_rollup_group
         ON display_rollup_group.id = input.display_group_id
       GROUP BY
         input.display_group_id,
         display_rollup_group.level,
         display_rollup_group.source,
         3
       ON CONFLICT (project_id, display_group_id, bucket_at) DO UPDATE
       SET event_count = display_error_rollups_hourly.event_count + EXCLUDED.event_count,
           first_seen_at = LEAST(
             display_error_rollups_hourly.first_seen_at,
             EXCLUDED.first_seen_at
           ),
           last_seen_at = GREATEST(
             display_error_rollups_hourly.last_seen_at,
             EXCLUDED.last_seen_at
           ),
           level = EXCLUDED.level,
           source = EXCLUDED.source
       RETURNING display_group_id
     ), display_variants AS (
       INSERT INTO display_error_variants_hourly (
         project_id, display_group_id, bucket_at, message_hash, message,
         event_count, first_seen_at, last_seen_at
       )
       SELECT
         $1,
         inserted.display_group_id,
         date_trunc(
           'hour',
           inserted.occurred_at AT TIME ZONE 'UTC'
         ) AT TIME ZONE 'UTC',
         digest(
           COALESCE(inserted.original_message, groups.normalized_message),
           'sha256'
         ),
         COALESCE(inserted.original_message, groups.normalized_message),
         SUM(inserted.repeat_count)::bigint,
         MIN(inserted.occurred_at),
         MAX(COALESCE(inserted.last_occurred_at, inserted.occurred_at))
       FROM inserted
       JOIN error_groups groups ON groups.id = inserted.group_id
       GROUP BY inserted.display_group_id, 3, 4, 5
       ON CONFLICT (
         project_id, display_group_id, bucket_at, message_hash
       ) DO UPDATE
       SET event_count =
             display_error_variants_hourly.event_count + EXCLUDED.event_count,
           message = EXCLUDED.message,
           first_seen_at = LEAST(
             display_error_variants_hourly.first_seen_at,
             EXCLUDED.first_seen_at
           ),
           last_seen_at = GREATEST(
             display_error_variants_hourly.last_seen_at,
             EXCLUDED.last_seen_at
           )
       RETURNING display_group_id
     ), display_players AS (
       INSERT INTO display_error_group_players (
         project_id, display_group_id, player_id, last_seen_at
       )
       SELECT
         $1,
         input.display_group_id,
         sessions.player_id,
         MAX(inserted.occurred_at)
       FROM inserted
       JOIN input
         ON input.id = inserted.id
        AND input.occurred_at = inserted.occurred_at
       JOIN sessions ON sessions.id = inserted.session_id
       WHERE sessions.player_id IS NOT NULL
       GROUP BY input.display_group_id, sessions.player_id
       ON CONFLICT (project_id, display_group_id, player_id) DO UPDATE
       SET last_seen_at = GREATEST(
         display_error_group_players.last_seen_at,
         EXCLUDED.last_seen_at
       )
       RETURNING display_group_id
     ), display_jobs AS (
       INSERT INTO display_error_group_jobs (
         project_id, display_group_id, job_id, last_seen_at
       )
       SELECT
         $1,
         input.display_group_id,
         $2,
         MAX(inserted.occurred_at)
       FROM inserted
       JOIN input
         ON input.id = inserted.id
        AND input.occurred_at = inserted.occurred_at
       GROUP BY input.display_group_id
       ON CONFLICT (project_id, display_group_id, job_id) DO UPDATE
       SET last_seen_at = GREATEST(
         display_error_group_jobs.last_seen_at,
         EXCLUDED.last_seen_at
       )
       RETURNING display_group_id
     ),
     updated AS (
       UPDATE error_groups groups
       SET first_seen_at = LEAST(groups.first_seen_at, totals.first_seen_at),
           last_seen_at = GREATEST(groups.last_seen_at, totals.last_seen_at),
           occurrence_count = groups.occurrence_count + totals.occurrence_count
       FROM totals
       WHERE groups.id = totals.group_id
       RETURNING groups.id
     )
     SELECT
       COALESCE(SUM(inserted.repeat_count), 0)::int AS accepted,
       (SELECT COUNT(*) FROM updated) AS updated_group_count,
       (SELECT COUNT(*) FROM live_rollups) AS updated_rollup_count,
       (SELECT COUNT(*) FROM display_live_rollups) AS updated_display_rollup_count,
       (SELECT COUNT(*) FROM display_variants) AS updated_display_variant_count,
       (SELECT COUNT(*) FROM display_players) AS updated_display_player_count,
       (SELECT COUNT(*) FROM display_jobs) AS updated_display_job_count
     FROM inserted`,
    [projectId, jobId, JSON.stringify(occurrences)],
  );
  const accepted = result.rows[0]?.accepted ?? 0;
  return { accepted, duplicates: logicalEventCount - accepted };
}

async function insertFeedback(
  client: PoolClient,
  projectId: string,
  batch: IngestBatch,
): Promise<number> {
  if (batch.feedback.length === 0) return 0;
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1::text || ':' || sessions.player_id::text, 0)
     )
     FROM jsonb_to_recordset($2::jsonb) AS feedback_input(session_id uuid)
     JOIN sessions ON sessions.id = feedback_input.session_id
                  AND sessions.project_id = $1
     ORDER BY sessions.player_id`,
    [projectId, JSON.stringify(batch.feedback.map((item) => ({ session_id: item.sessionId })))],
  );
  const result = await client.query<{ accepted: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS feedback_input(
         id uuid, session_id uuid, submitted_at timestamptz, message text
       )
     ), candidates AS (
       SELECT DISTINCT ON (sessions.player_id)
         input.*, sessions.player_id
       FROM input
       JOIN sessions ON sessions.id = input.session_id
                    AND sessions.project_id = $1
       ORDER BY sessions.player_id, input.submitted_at
     ), inserted AS (
       INSERT INTO feedback (id, project_id, session_id, player_id, submitted_at, message)
       SELECT candidates.id, $1, candidates.session_id, candidates.player_id,
              candidates.submitted_at, candidates.message
       FROM candidates
       WHERE NOT EXISTS (
         SELECT 1 FROM feedback existing
         WHERE existing.project_id = $1
           AND existing.player_id = candidates.player_id
           AND existing.submitted_at > candidates.submitted_at - INTERVAL '24 hours'
       )
       ON CONFLICT DO NOTHING
       RETURNING id
     ) SELECT COUNT(*)::int AS accepted FROM inserted`,
    [projectId, JSON.stringify(batch.feedback.map((item) => ({
      id: item.id,
      session_id: item.sessionId,
      submitted_at: item.submittedAt,
      message: item.message,
    })))],
  );
  return result.rows[0]?.accepted ?? 0;
}

export async function ingestBatch(
  pool: Pool,
  projectId: string,
  batch: IngestBatch,
): Promise<IngestResult> {
  const ingest = () => withTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('trace-job:' || $1::text || ':' || $2::text, 0)
       )`,
      [projectId, batch.job.robloxJobId],
    );
    const jobId = await upsertJob(client, projectId, batch);
    await upsertSessions(client, projectId, jobId, batch);
    const result = await insertEvents(client, projectId, jobId, batch);
    await insertFeedback(client, projectId, batch);
    return result;
  });

  try {
    return await ingest();
  } catch (error) {
    const postgresError = error as { code?: string; message?: string };
    const missingOccurrencePartition =
      postgresError.code === "23514" &&
      postgresError.message?.includes(
        'no partition of relation "occurrences" found for row',
      );

    if (!missingOccurrencePartition) throw error;

    await pool.query("SELECT ensure_occurrence_partitions(3)");
    return ingest();
  }
}
