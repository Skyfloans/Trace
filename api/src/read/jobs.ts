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
const jobParamsSchema = projectParamsSchema.extend({
  serverJobId: z.uuid(),
});

function cache(reply: FastifyReply, seconds = 5): void {
  reply.header(
    "Cache-Control",
    `private, max-age=${seconds}, stale-while-revalidate=${seconds * 3}`,
  );
}

function mapJob(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    robloxJobId: String(row.roblox_job_id),
    placeId: String(row.place_id),
    region: row.region ? String(row.region) : null,
    startedAt: iso(row.started_at as Date | string),
    endedAt: row.ended_at
      ? iso(row.ended_at as Date | string)
      : null,
  };
}

export async function registerJobRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
): Promise<void> {
  app.get(
    "/v1/projects/:projectId/server-jobs",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
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
        `j.project_id = ${parameters.add(projectId)}`,
        `j.started_at < ${parameters.add(time.to)}`,
        `COALESCE(j.ended_at, j.last_seen_at) >= ${parameters.add(time.from)}`,
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
          `(j.started_at, j.id) < (${parameters.add(values[0])}, ${parameters.add(values[1])})`,
        );
      }

      const result = await pool.query(
        `SELECT j.id, j.roblox_job_id, j.place_id, j.region, j.started_at, j.ended_at
         FROM jobs j
         WHERE ${conditions.join(" AND ")}
         ORDER BY j.started_at DESC, j.id DESC
         LIMIT ${parameters.add(limit + 1)}`,
        parameters.values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply);
      return {
        data: rows.map(mapJob),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.started_at), last.id])
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/server-jobs/:serverJobId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, serverJobId } = jobParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT
           j.id, j.roblox_job_id, j.place_id, j.region, j.started_at, j.ended_at,
           session_stats.session_count,
           event_stats.event_count,
           event_stats.error_count,
           event_stats.warning_count
         FROM jobs j
         JOIN LATERAL (
           SELECT COUNT(*)::int AS session_count
           FROM sessions s
           WHERE s.project_id = j.project_id AND s.job_id = j.id
         ) session_stats ON true
         JOIN LATERAL (
           SELECT
             COALESCE(SUM(o.repeat_count), 0)::int AS event_count,
             COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.level = 'error'), 0)::int AS error_count,
             COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.level = 'warning'), 0)::int AS warning_count
           FROM occurrences o
           JOIN error_groups eg ON eg.id = o.group_id
           WHERE o.project_id = j.project_id AND o.job_id = j.id
         ) event_stats ON true
         WHERE j.project_id = $1 AND j.id = $2
        `,
        [projectId, serverJobId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "server_job_not_found",
          "The server job was not found.",
        );
      }

      cache(reply);
      return {
        ...mapJob(row),
        sessionCount: row.session_count,
        eventCount: row.event_count,
        errorCount: row.error_count,
        warningCount: row.warning_count,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/server-jobs/:serverJobId/logs",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, serverJobId } = jobParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const severities = parseCsvEnum(
        typeof query.severity === "string" ? query.severity : undefined,
        severitySchema,
      );
      const limit = clampLimit(
        query.limit as string | undefined,
        200,
        500,
      );
      const parameters = new QueryParameters();
      const conditions = [
        `o.project_id = ${parameters.add(projectId)}`,
        `o.job_id = ${parameters.add(serverJobId)}`,
      ];
      if (severities) {
        conditions.push(
          `eg.level = ANY(${parameters.addArray(severities)}::log_level[])`,
        );
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
    "/v1/projects/:projectId/server-jobs/:serverJobId/sessions",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, serverJobId } = jobParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const limit = clampLimit(
        query.limit as string | undefined,
        50,
        100,
      );
      const parameters = new QueryParameters();
      const conditions = [
        `s.project_id = ${parameters.add(projectId)}`,
        `s.job_id = ${parameters.add(serverJobId)}`,
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
}
