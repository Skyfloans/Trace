import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ArchiveStorage } from "../archive-storage.js";
import {
  decodeArchiveChunk,
  readArchiveManifest,
  type ArchivedOccurrence,
} from "../telemetry-archive.js";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  iso,
  parseCsvEnum,
  parseTimeRange,
  ReadApiError,
  severitySchema,
  sideSchema,
} from "./http.js";
import {
  mapOccurrence,
  mapSession,
  occurrenceSelect,
  sessionCountJoin,
  sessionSelect,
} from "./mappers.js";
import { QueryParameters } from "./query.js";
import { requireProjectMembership } from "./auth.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

const projectParamsSchema = z.object({ projectId: z.uuid() });
const playerParamsSchema = projectParamsSchema.extend({
  robloxUserId: z.string().regex(/^\d{1,20}$/),
});
const sessionParamsSchema = projectParamsSchema.extend({
  sessionId: z.uuid(),
});
const occurrenceParamsSchema = projectParamsSchema.extend({
  occurrenceId: z.uuid(),
});

function cache(reply: FastifyReply, seconds = 5): void {
  reply.header(
    "Cache-Control",
    `private, max-age=${seconds}, stale-while-revalidate=${seconds * 3}`,
  );
}

function playerResponse(row: Record<string, unknown>) {
  const username = row.player_name
    ? String(row.player_name)
    : String(row.player_id);
  return {
    robloxUserId: String(row.player_id),
    username,
    displayName: row.player_display_name
      ? String(row.player_display_name)
      : username,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
  };
}

async function readRecentPlayers(
  pool: Pool,
  projectId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const players = new Map<string, Record<string, unknown>>();
  const batchSize = Math.max(250, limit * 5);
  let cursorTime: unknown = null;
  let cursorId: unknown = null;

  while (players.size < limit) {
    const result = await pool.query(
      `SELECT
         s.id, s.player_id, s.player_name, s.player_display_name,
         s.avatar_url, s.started_at, s.last_seen_at
       FROM sessions s
       WHERE s.project_id = $1
         AND ($2::timestamptz IS NULL OR (s.started_at, s.id) < ($2, $3::uuid))
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT $4`,
      [projectId, cursorTime, cursorId, batchSize],
    );

    for (const row of result.rows) {
      const playerId = String(row.player_id);
      if (!players.has(playerId)) players.set(playerId, row);
      if (players.size >= limit) break;
    }

    const last = result.rows.at(-1);
    if (!last || result.rows.length < batchSize) break;
    cursorTime = last.started_at;
    cursorId = last.id;
  }

  return [...players.values()];
}

function readEventFilters(query: Record<string, unknown>) {
  return {
    severities: parseCsvEnum(
      typeof query.severity === "string" ? query.severity : undefined,
      severitySchema,
    ),
    sides: parseCsvEnum(
      typeof query.side === "string" ? query.side : undefined,
      sideSchema,
    ),
  };
}

function correlateServerEvents(
  occurrences: Array<ReturnType<typeof mapOccurrence>>,
  sessionId: string,
) {
  const clientOccurrences = occurrences.filter(
    (occurrence) => occurrence.side === "client",
  );
  return occurrences.map((occurrence) => {
    if (
      occurrence.side !== "server"
      || occurrence.sessionId === sessionId
      || "correlation" in occurrence
    ) {
      return occurrence;
    }
    const occurredAt = Date.parse(occurrence.occurredAt);
    const nearest = clientOccurrences
      .map((clientOccurrence) => ({
        occurrence: clientOccurrence,
        deltaMs: Math.abs(
          Date.parse(clientOccurrence.occurredAt) - occurredAt,
        ),
      }))
      .filter((candidate) => candidate.deltaMs <= 2_000)
      .sort((left, right) => left.deltaMs - right.deltaMs)[0];
    return nearest
      ? {
          ...occurrence,
          correlation: {
            kind: "time_window" as const,
            confidence: "low" as const,
            relatedOccurrenceId: nearest.occurrence.id,
            deltaMs: nearest.deltaMs,
          },
        }
      : occurrence;
  });
}

function utcDatesBetween(startedAt: unknown, endedAt: unknown): string[] {
  const cursor = new Date(String(startedAt));
  const end = new Date(String(endedAt));
  cursor.setUTCHours(0, 0, 0, 0);
  const dates: string[] = [];
  while (cursor <= end && dates.length < 5) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function archivedDatesBetween(startedAt: unknown, endedAt: unknown): string[] {
  const archiveCutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  archiveCutoff.setUTCHours(0, 0, 0, 0);
  archiveCutoff.setUTCDate(archiveCutoff.getUTCDate() - 1);
  const latestArchivedDate = archiveCutoff.toISOString().slice(0, 10);
  return utcDatesBetween(startedAt, endedAt).filter(
    (date) => date <= latestArchivedDate,
  );
}

async function readArchivedSessionTimeline(options: {
  archiveStorage: ArchiveStorage;
  endedAt: unknown;
  jobId: string;
  projectId: string;
  sessionId: string;
  severities: string[] | undefined;
  sides: string[] | undefined;
  startedAt: unknown;
}): Promise<ArchivedOccurrence[]> {
  const startedAtMs = new Date(String(options.startedAt)).getTime();
  const endedAtMs = new Date(String(options.endedAt)).getTime();
  const results: ArchivedOccurrence[] = [];

  const dates = archivedDatesBetween(options.startedAt, options.endedAt);
  if (dates.length === 0) return results;

  const manifests = await Promise.all(
    dates.map((date) => readArchiveManifest(options.archiveStorage, date)),
  );
  const chunks = manifests.flatMap((manifest) =>
    manifest?.chunks.filter(
      (chunk) =>
        chunk.projectId === options.projectId &&
        chunk.jobId === options.jobId &&
        Date.parse(chunk.firstOccurredAt) <= endedAtMs &&
        Date.parse(chunk.lastOccurredAt) >= startedAtMs,
    ) ?? [],
  );
  const bodies = await Promise.all(
    chunks.map(async (chunk) => {
      const body = await options.archiveStorage.get(chunk.key);
      if (!body) throw new Error(`missing telemetry archive chunk ${chunk.key}`);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (sha256 !== chunk.sha256) {
        throw new Error(`telemetry archive checksum mismatch for ${chunk.key}`);
      }
      return body;
    }),
  );

  for (const body of bodies) {
    for (const occurrence of decodeArchiveChunk(body)) {
      const occurredAtMs = Date.parse(occurrence.occurredAt);
      const belongsToTimeline =
        occurrence.sessionId === options.sessionId ||
        (occurrence.side === "server" &&
          occurredAtMs >= startedAtMs &&
          occurredAtMs <= endedAtMs);
      if (!belongsToTimeline) continue;
      if (options.severities && !options.severities.includes(occurrence.severity)) {
        continue;
      }
      if (options.sides && !options.sides.includes(occurrence.side)) continue;
      results.push(occurrence);
    }
  }
  return results;
}

export async function registerSessionAndLogRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
  archiveStorage: ArchiveStorage | null = null,
): Promise<void> {
  app.get(
    "/v1/projects/:projectId/players",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const search = z
        .string()
        .trim()
        .max(64)
        .optional()
        .default("")
        .parse(query.query);
      const limit = clampLimit(query.limit as string | undefined, 20, 50);
      const numeric = search.length > 0 && /^\d+$/.test(search);

      const rows = search
        ? (await pool.query(
          `WITH ranked AS (
           SELECT DISTINCT ON (s.player_id)
             s.player_id, s.player_name, s.player_display_name, s.avatar_url,
             CASE
               WHEN $2::boolean AND s.player_id::text = $3::text THEN 0
               WHEN lower(s.player_name) = lower($3::text) THEN 1
               WHEN lower(s.player_name) LIKE lower($3::text) || '%' THEN 2
               WHEN lower(s.player_display_name) = lower($3::text) THEN 3
               ELSE 4
             END AS rank
           FROM sessions s
           WHERE s.project_id = $1
             AND (
               ($2::boolean AND s.player_id::text = $3::text)
               OR lower(s.player_name) LIKE lower($3::text) || '%'
               OR lower(COALESCE(s.player_display_name, '')) LIKE lower($3::text) || '%'
             )
           ORDER BY s.player_id, rank, s.started_at DESC
         )
         SELECT *
         FROM ranked
         ORDER BY rank, lower(player_name), player_id
         LIMIT $4`,
          [projectId, numeric, search, limit],
        )).rows
        : await readRecentPlayers(pool, projectId, limit);

      cache(reply, 10);
      return {
        data: rows.map(playerResponse),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/players/:robloxUserId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, robloxUserId } = playerParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT player_id, player_name, player_display_name, avatar_url
         FROM sessions
         WHERE project_id = $1 AND player_id = $2
         ORDER BY started_at DESC
         LIMIT 1`,
        [projectId, robloxUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "player_not_found",
          "The player was not found in retained sessions.",
        );
      }

      cache(reply, 10);
      return playerResponse(row);
    },
  );

  app.get(
    "/v1/projects/:projectId/players/:robloxUserId/sessions",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, robloxUserId } = playerParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const time = parseTimeRange(
        typeof query.from === "string" ? query.from : undefined,
        typeof query.to === "string" ? query.to : undefined,
      );
      const limit = clampLimit(
        query.limit as string | undefined,
        50,
        100,
      );
      const parameters = new QueryParameters();
      const conditions = [
        `s.project_id = ${parameters.add(projectId)}`,
        `s.player_id = ${parameters.add(robloxUserId)}`,
        `s.started_at < ${parameters.add(time.to)}`,
        `COALESCE(s.ended_at, s.last_seen_at) >= ${parameters.add(time.from)}`,
      ];
      if (typeof query.cursor === "string") {
        const values = decodeCursor(query.cursor);
        if (
          values.length !== 2 ||
          typeof values[0] !== "string" ||
          typeof values[1] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
        conditions.push(
          `(s.started_at, s.id) < (${parameters.add(values[0])}, ${parameters.add(values[1])})`,
        );
      }

      const result = await pool.query(
        `SELECT ${sessionSelect}
         FROM sessions s
         JOIN jobs j ON j.id = s.job_id
         ${sessionCountJoin}
         WHERE ${conditions.join(" AND ")}
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT ${parameters.add(limit + 1)}`,
        parameters.values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply);
      return {
        data: rows.map(mapSession),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.started_at), last.id])
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, sessionId } = sessionParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT ${sessionSelect}
         FROM sessions s
         JOIN jobs j ON j.id = s.job_id
         ${sessionCountJoin}
         WHERE s.project_id = $1 AND s.id = $2`,
        [projectId, sessionId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "session_not_found",
          "The session was not found.",
        );
      }

      cache(reply);
      return mapSession(row);
    },
  );

  app.get(
    "/v1/projects/:projectId/logs",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const time = parseTimeRange(
        typeof query.from === "string" ? query.from : undefined,
        typeof query.to === "string" ? query.to : undefined,
      );
      const { severities, sides } = readEventFilters(query);
      const limit = clampLimit(
        query.limit as string | undefined,
        100,
        100,
      );
      const parameters = new QueryParameters();
      const conditions = [
        `o.project_id = ${parameters.add(projectId)}`,
        `o.occurred_at >= ${parameters.add(time.from)}`,
        `o.occurred_at < ${parameters.add(time.to)}`,
      ];
      if (severities) {
        conditions.push(
          `eg.level = ANY(${parameters.addArray(severities)}::log_level[])`,
        );
      }
      if (sides) {
        conditions.push(
          `eg.source = ANY(${parameters.addArray(sides)}::log_source[])`,
        );
      }
      if (typeof query.playerId === "string") {
        conditions.push(`s.player_id = ${parameters.add(query.playerId)}`);
      }
      if (typeof query.serverJobId === "string") {
        conditions.push(`o.job_id = ${parameters.add(query.serverJobId)}`);
      }
      if (typeof query.q === "string" && query.q.trim()) {
        const searchText = z
          .string()
          .trim()
          .min(3, "Log search requires at least three characters.")
          .max(128)
          .parse(query.q);
        const search = `%${searchText}%`;
        const value = parameters.add(search);
        conditions.push(`(
          COALESCE(o.original_message, eg.normalized_message) ILIKE ${value}
          OR COALESCE(eg.source_script, '') ILIKE ${value}
          OR COALESCE(s.player_name, '') ILIKE ${value}
          OR COALESCE(s.player_id::text, '') ILIKE ${value}
          OR j.roblox_job_id ILIKE ${value}
        )`);
      }
      if (typeof query.cursor === "string") {
        const values = decodeCursor(query.cursor);
        if (
          values.length !== 2 ||
          typeof values[0] !== "string" ||
          typeof values[1] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
        conditions.push(
          `(o.occurred_at, o.id) < (${parameters.add(values[0])}, ${parameters.add(values[1])})`,
        );
      }

      const result = await pool.query(
        `SELECT ${occurrenceSelect}
         FROM occurrences o
         JOIN error_groups eg ON eg.id = o.group_id
         JOIN jobs j ON j.id = o.job_id
         LEFT JOIN sessions s ON s.id = o.session_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY o.occurred_at DESC, o.id DESC
         LIMIT ${parameters.add(limit + 1)}`,
        parameters.values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply);
      return {
        data: rows.map(mapOccurrence),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.occurred_at), last.id])
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/logs/:occurrenceId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, occurrenceId } = occurrenceParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT ${occurrenceSelect}
         FROM occurrences o
         JOIN error_groups eg ON eg.id = o.group_id
         LEFT JOIN sessions s ON s.id = o.session_id
         WHERE o.project_id = $1 AND o.id = $2
         ORDER BY o.occurred_at DESC
         LIMIT 1`,
        [projectId, occurrenceId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "occurrence_not_found",
          "The log occurrence was not found.",
        );
      }

      cache(reply);
      return mapOccurrence(row);
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId/timeline",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, sessionId } = sessionParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const sessionExists = await pool.query(
        `SELECT job_id, started_at, COALESCE(ended_at, now()) AS ended_at
         FROM sessions WHERE project_id = $1 AND id = $2`,
        [projectId, sessionId],
      );
      if (sessionExists.rowCount !== 1) {
        throw new ReadApiError(
          404,
          "session_not_found",
          "The session was not found.",
        );
      }
      const query = request.query as Record<string, unknown>;
      const includeAllServer = query.includeAllServer === "true";
      const { severities, sides } = readEventFilters(query);
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const session = parameters.add(sessionId);
      const timelineConditions: string[] = [];
      if (severities) {
        timelineConditions.push(
          `severity = ANY(${parameters.addArray(severities)}::log_level[])`,
        );
      }
      if (sides) {
        timelineConditions.push(
          `side = ANY(${parameters.addArray(sides)}::log_source[])`,
        );
      }

      let selection: string;
      let resultLimit: number;
      if (typeof query.around === "string") {
        const around = z.uuid().parse(query.around);
        const before = clampLimit(
          query.before as string | undefined,
          100,
          250,
        );
        const after = clampLimit(
          query.after as string | undefined,
          100,
          250,
        );
        const anchorResult = await pool.query(
          `SELECT occurred_at, id
           FROM occurrences
           WHERE project_id = $1 AND id = $2
           ORDER BY occurred_at DESC
           LIMIT 1`,
          [projectId, around],
        );
        const anchor = anchorResult.rows[0];
        if (!anchor) {
          throw new ReadApiError(
            404,
            "occurrence_not_found",
            "The selected timeline occurrence was not found.",
          );
        }
        const anchorTime = parameters.add(anchor.occurred_at);
        const anchorId = parameters.add(anchor.id);
        selection = `selected AS (
          (SELECT * FROM filtered
           WHERE (occurred_at, id) < (${anchorTime}, ${anchorId})
           ORDER BY occurred_at DESC, id DESC
           LIMIT ${parameters.add(before)})
          UNION ALL
          (SELECT * FROM filtered
           WHERE (occurred_at, id) >= (${anchorTime}, ${anchorId})
           ORDER BY occurred_at, id
           LIMIT ${parameters.add(after + 1)})
        )`;
        resultLimit = before + after + 1;
      } else {
        const limit = clampLimit(
          query.limit as string | undefined,
          200,
          500,
        );
        const cursorConditions: string[] = [];
        if (typeof query.cursor === "string") {
          const values = decodeCursor(query.cursor);
          if (
            values.length !== 2 ||
            typeof values[0] !== "string" ||
            typeof values[1] !== "string"
          ) {
            throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
          }
          cursorConditions.push(
            `(occurred_at, id) > (${parameters.add(values[0])}, ${parameters.add(values[1])})`,
          );
        }
        selection = `selected AS (
          SELECT * FROM filtered
          ${cursorConditions.length ? `WHERE ${cursorConditions.join(" AND ")}` : ""}
          ORDER BY occurred_at, id
          LIMIT ${parameters.add(limit + 1)}
        )`;
        resultLimit = limit;
      }

      const result = await pool.query(
        `WITH target_session AS MATERIALIZED (
           SELECT id, job_id, started_at, COALESCE(ended_at, now()) AS ended_at
           FROM sessions
           WHERE project_id = ${project} AND id = ${session}
         ),
         timeline AS (
           SELECT
             ${occurrenceSelect},
             NULL::uuid AS related_occurrence_id,
             NULL::double precision AS delta_ms
           FROM occurrences o
           JOIN target_session ts
             ON ts.id = o.session_id
            AND o.project_id = ${project}
           JOIN error_groups eg ON eg.id = o.group_id
           LEFT JOIN sessions s ON s.id = o.session_id
           UNION ALL
           SELECT
             ${occurrenceSelect},
             NULL::uuid AS related_occurrence_id,
             NULL::double precision AS delta_ms
           FROM target_session ts
           JOIN occurrences o
             ON o.project_id = ${project}
            AND o.job_id = ts.job_id
            AND o.session_id IS DISTINCT FROM ts.id
            AND o.occurred_at BETWEEN ts.started_at AND ts.ended_at
           JOIN error_groups eg
             ON eg.id = o.group_id
            AND eg.source = 'server'
           LEFT JOIN sessions s ON s.id = o.session_id
         ),
         filtered AS (
           SELECT *
           FROM timeline
           ${timelineConditions.length ? `WHERE ${timelineConditions.join(" AND ")}` : ""}
         ),
         ${selection},
         displayed AS (
           SELECT * FROM selected
           ${includeAllServer ? `UNION ALL
           SELECT server_events.*
           FROM filtered server_events
           WHERE server_events.side = 'server'
             AND NOT EXISTS (
               SELECT 1
               FROM selected
               WHERE selected.id = server_events.id
                 AND selected.occurred_at = server_events.occurred_at
             )` : ""}
         )
         SELECT *
         FROM displayed
         ORDER BY displayed.occurred_at, displayed.id`,
        parameters.values,
      );

      const hasMore =
        !includeAllServer &&
        typeof query.around !== "string" &&
        result.rows.length > resultLimit;
      const rows = includeAllServer
        ? result.rows
        : result.rows.slice(0, resultLimit);
      let data = rows.map(mapOccurrence);
      if (archiveStorage && includeAllServer) {
        const targetSession = sessionExists.rows[0]!;
        const archived = await readArchivedSessionTimeline({
          archiveStorage,
          projectId,
          sessionId,
          jobId: String(targetSession.job_id),
          startedAt: targetSession.started_at,
          endedAt: targetSession.ended_at,
          severities,
          sides,
        });
        const byId = new Map(data.map((occurrence) => [occurrence.id, occurrence]));
        for (const occurrence of archived) byId.set(occurrence.id, occurrence);
        data = [...byId.values()].sort(
          (left, right) =>
            Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
            left.id.localeCompare(right.id),
        );
      }
      data = correlateServerEvents(data, sessionId);
      const last = rows.at(-1);
      cache(reply);
      return {
        data,
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.occurred_at), last.id])
            : null,
      };
    },
  );
}
