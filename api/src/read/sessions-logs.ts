import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
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

export async function registerSessionAndLogRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
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

      const result = search
        ? await pool.query(
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
        )
        : await pool.query(
          `WITH recent AS (
             SELECT DISTINCT ON (s.player_id)
               s.player_id, s.player_name, s.player_display_name, s.avatar_url,
               s.last_seen_at
             FROM sessions s
             WHERE s.project_id = $1
             ORDER BY s.player_id, s.last_seen_at DESC
           )
           SELECT *
           FROM recent
           ORDER BY last_seen_at DESC NULLS LAST, player_id
           LIMIT $2`,
          [projectId, limit],
        );

      cache(reply, 10);
      return {
        data: result.rows.map(playerResponse),
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
        `SELECT 1 FROM sessions WHERE project_id = $1 AND id = $2`,
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
      const { severities, sides } = readEventFilters(query);
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const session = parameters.add(sessionId);
      const timelineConditions: string[] = [];
      if (severities) {
        timelineConditions.push(
          `eg.level = ANY(${parameters.addArray(severities)}::log_level[])`,
        );
      }
      if (sides) {
        timelineConditions.push(
          `eg.source = ANY(${parameters.addArray(sides)}::log_source[])`,
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
        `WITH target_session AS (
           SELECT id, job_id, started_at, COALESCE(ended_at, last_seen_at) AS ended_at
           FROM sessions
           WHERE project_id = ${project} AND id = ${session}
         ),
         timeline_ids AS (
           SELECT
             o.id, o.occurred_at, NULL::uuid AS related_occurrence_id,
             NULL::double precision AS delta_ms
           FROM occurrences o
           JOIN target_session ts ON ts.id = o.session_id
           UNION ALL
           SELECT
             server_event.id,
             server_event.occurred_at,
             nearest.id AS related_occurrence_id,
             nearest.delta_ms
           FROM target_session ts
           JOIN occurrences server_event
             ON server_event.project_id = ${project}
            AND server_event.job_id = ts.job_id
            AND server_event.session_id IS NULL
            AND server_event.occurred_at BETWEEN ts.started_at AND ts.ended_at
           JOIN LATERAL (
             SELECT
               client_event.id,
               ABS(EXTRACT(EPOCH FROM (
                 client_event.occurred_at - server_event.occurred_at
               )) * 1000) AS delta_ms
             FROM occurrences client_event
             WHERE client_event.project_id = ${project}
               AND client_event.session_id = ts.id
               AND client_event.occurred_at BETWEEN
                 server_event.occurred_at - interval '2 seconds'
                 AND server_event.occurred_at + interval '2 seconds'
             ORDER BY ABS(EXTRACT(EPOCH FROM (
               client_event.occurred_at - server_event.occurred_at
             ))), client_event.id
             LIMIT 1
           ) nearest ON true
         ),
         filtered AS (
           SELECT timeline_ids.*
           FROM timeline_ids
           JOIN occurrences o
             ON o.id = timeline_ids.id
            AND o.occurred_at = timeline_ids.occurred_at
           JOIN error_groups eg ON eg.id = o.group_id
           ${timelineConditions.length ? `WHERE ${timelineConditions.join(" AND ")}` : ""}
         ),
         ${selection}
         SELECT
           ${occurrenceSelect},
           selected.related_occurrence_id,
           selected.delta_ms
         FROM selected
         JOIN occurrences o
           ON o.id = selected.id
          AND o.occurred_at = selected.occurred_at
         JOIN error_groups eg ON eg.id = o.group_id
         LEFT JOIN sessions s ON s.id = o.session_id
         ORDER BY o.occurred_at, o.id`,
        parameters.values,
      );

      const hasMore =
        typeof query.around !== "string" && result.rows.length > resultLimit;
      const rows = result.rows.slice(0, resultLimit);
      const data = rows.map((row) => {
        const occurrence = mapOccurrence(row);
        if (row.related_occurrence_id) {
          return {
            ...occurrence,
            correlation: {
              kind: "time_window",
              confidence: "low",
              relatedOccurrenceId: row.related_occurrence_id,
              deltaMs: Number(row.delta_ms),
            },
          };
        }
        return occurrence;
      });
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
