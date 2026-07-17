import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  decodeCursor,
  encodeCursor,
  iso,
  parseCsvEnum,
  parseTimeRange,
  clampLimit,
  ReadApiError,
  severitySchema,
  sideSchema,
} from "./http.js";
import { mapOccurrence, occurrenceSelect } from "./mappers.js";
import { QueryParameters } from "./query.js";
import {
  requireProjectMembership,
  requireReadUser,
} from "./auth.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

function cache(reply: FastifyReply, seconds = 5): void {
  reply.header(
    "Cache-Control",
    `private, max-age=${seconds}, stale-while-revalidate=${seconds * 3}`,
  );
}

const projectParamsSchema = z.object({ projectId: z.uuid() });
const fingerprintParamsSchema = projectParamsSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

function readListFilters(query: Record<string, unknown>) {
  return {
    time: parseTimeRange(
      typeof query.from === "string" ? query.from : undefined,
      typeof query.to === "string" ? query.to : undefined,
    ),
    severities: parseCsvEnum(
      typeof query.severity === "string" ? query.severity : "error,warning",
      severitySchema,
    )!,
    sides: parseCsvEnum(
      typeof query.side === "string" ? query.side : undefined,
      sideSchema,
    ),
  };
}

export async function registerProjectAndErrorRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
): Promise<void> {
  app.get(
    "/v1/projects",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = requireReadUser(request);
      const result = await pool.query(
        `SELECT p.id, p.name, p.roblox_universe_id, p.icon_url
         FROM projects p
         JOIN project_memberships pm ON pm.project_id = p.id
         WHERE pm.user_id = $1
         ORDER BY p.name, p.id`,
        [user.id],
      );

      cache(reply, 15);
      return {
        data: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          robloxUniverseId: row.roblox_universe_id,
          iconUrl: row.icon_url,
        })),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT id, name, roblox_universe_id, icon_url
         FROM projects
         WHERE id = $1`,
        [projectId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "project_not_found",
          "The project was not found.",
        );
      }

      cache(reply, 15);
      return {
        id: row.id,
        name: row.name,
        robloxUniverseId: row.roblox_universe_id,
        iconUrl: row.icon_url,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/errors",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const { time, severities, sides } = readListFilters(query);
      const limit = clampLimit(
        query.limit as string | undefined,
        50,
        100,
      );
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const from = parameters.add(time.from);
      const to = parameters.add(time.to);
      const severity = parameters.addArray(severities);
      const conditions = [
        `o.project_id = ${project}`,
        `o.occurred_at >= ${from}`,
        `o.occurred_at < ${to}`,
        `eg.level = ANY(${severity}::log_level[])`,
      ];
      if (sides) {
        conditions.push(
          `eg.source = ANY(${parameters.addArray(sides)}::log_source[])`,
        );
      }

      let cursorCondition = "";
      if (typeof query.cursor === "string") {
        const values = decodeCursor(query.cursor);
        if (
          values.length !== 3 ||
          typeof values[0] !== "number" ||
          typeof values[1] !== "string" ||
          typeof values[2] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
        cursorCondition = `WHERE (stats.event_count, stats.last_seen_at, stats.group_id)
          < (${parameters.add(values[0])}, ${parameters.add(values[1])}, ${parameters.add(values[2])})`;
      }
      const rowLimit = parameters.add(limit + 1);

      const result = await pool.query(
        `WITH stats AS (
           SELECT
             o.group_id,
             SUM(o.repeat_count)::int AS event_count,
             COUNT(DISTINCT s.player_id)::int AS affected_player_count,
             COUNT(DISTINCT o.job_id)::int AS affected_server_count,
             MIN(o.occurred_at) AS first_seen_at,
             MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
           FROM occurrences o
           JOIN error_groups eg ON eg.id = o.group_id
           LEFT JOIN sessions s ON s.id = o.session_id
           WHERE ${conditions.join(" AND ")}
           GROUP BY o.group_id
         ),
         paged AS (
           SELECT *
           FROM stats
           ${cursorCondition}
           ORDER BY event_count DESC, last_seen_at DESC, group_id DESC
           LIMIT ${rowLimit}
         )
         SELECT
           paged.group_id,
           paged.event_count,
           paged.affected_player_count,
           paged.affected_server_count,
           paged.first_seen_at,
           paged.last_seen_at,
           latest.id AS latest_occurrence_id,
           eg.fingerprint,
           eg.level,
           eg.source,
           eg.normalized_message,
           eg.source_script
         FROM paged
         JOIN error_groups eg ON eg.id = paged.group_id
         JOIN LATERAL (
           SELECT o.id
           FROM occurrences o
           WHERE o.project_id = ${project}
             AND o.group_id = paged.group_id
             AND o.occurred_at >= ${from}
             AND o.occurred_at < ${to}
           ORDER BY o.occurred_at DESC, o.id DESC
           LIMIT 1
         ) latest ON true
         ORDER BY paged.event_count DESC, paged.last_seen_at DESC, paged.group_id DESC`,
        parameters.values,
      );

      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply);
      return {
        data: rows.map((row) => ({
          fingerprint: row.fingerprint,
          severity: row.level,
          side: row.source,
          title: row.normalized_message,
          source: row.source_script,
          count: row.event_count,
          affectedPlayerCount: row.affected_player_count,
          affectedServerCount: row.affected_server_count,
          firstSeenAt: iso(row.first_seen_at),
          lastSeenAt: iso(row.last_seen_at),
          latestOccurrenceId: row.latest_occurrence_id,
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([
                last.event_count,
                iso(last.last_seen_at),
                last.group_id,
              ])
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/errors/:fingerprint",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, fingerprint } = fingerprintParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);

      const result = await pool.query(
        `WITH matching AS (
           SELECT o.*
           FROM occurrences o
           JOIN error_groups eg ON eg.id = o.group_id
           WHERE o.project_id = $1
             AND eg.fingerprint = $2
             AND o.occurred_at >= now() - interval '3 days'
         ),
         stats AS (
           SELECT
             COALESCE(SUM(matching.repeat_count), 0)::int AS event_count,
             COUNT(DISTINCT s.player_id)::int AS affected_player_count,
             COUNT(DISTINCT matching.job_id)::int AS affected_server_count,
             MIN(matching.occurred_at) AS first_seen_at,
             MAX(COALESCE(matching.last_occurred_at, matching.occurred_at)) AS last_seen_at
           FROM matching
           LEFT JOIN sessions s ON s.id = matching.session_id
         ),
         latest AS (
           SELECT * FROM matching
           ORDER BY occurred_at DESC, id DESC
           LIMIT 1
         )
         SELECT
           stats.*,
           eg.fingerprint,
           eg.level,
           eg.source AS group_source,
           eg.normalized_message,
           eg.source_script,
           ${occurrenceSelect}
         FROM stats
         JOIN latest o ON true
         JOIN error_groups eg ON eg.id = o.group_id
         LEFT JOIN sessions s ON s.id = o.session_id`,
        [projectId, fingerprint],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ReadApiError(
          404,
          "error_not_found",
          "The grouped error was not found.",
        );
      }

      cache(reply);
      return {
        error: {
          fingerprint: row.fingerprint,
          severity: row.level,
          side: row.group_source,
          title: row.normalized_message,
          source: row.source_script,
          count: row.event_count,
          affectedPlayerCount: row.affected_player_count,
          affectedServerCount: row.affected_server_count,
          firstSeenAt: iso(row.first_seen_at),
          lastSeenAt: iso(row.last_seen_at),
          latestOccurrenceId: row.id,
        },
        latestOccurrence: mapOccurrence(row),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/errors/:fingerprint/occurrences",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, fingerprint } = fingerprintParamsSchema.parse(
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
        `o.project_id = ${parameters.add(projectId)}`,
        `eg.fingerprint = ${parameters.add(fingerprint)}`,
        `o.occurred_at >= ${parameters.add(time.from)}`,
        `o.occurred_at < ${parameters.add(time.to)}`,
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
    "/v1/projects/:projectId/activity",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const { time, severities, sides } = readListFilters(query);
      const bucket = z
        .enum(["minute", "hour", "day"])
        .parse(typeof query.bucket === "string" ? query.bucket : "hour");
      const bucketMs = {
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
      }[bucket];
      const firstBucket = Math.floor(time.from.getTime() / bucketMs) * bucketMs;
      const bucketCount = Math.ceil((time.to.getTime() - firstBucket) / bucketMs);
      if (bucketCount > 1_000) {
        throw new ReadApiError(
          400,
          "too_many_buckets",
          "Choose a larger activity bucket for this time range.",
        );
      }

      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const from = parameters.add(time.from);
      const to = parameters.add(time.to);
      const severity = parameters.addArray(severities);
      const rawConditions = [
        `o.project_id = ${project}`,
        `o.occurred_at >= ${from}`,
        `o.occurred_at < ${to}`,
        `eg.level = ANY(${severity}::log_level[])`,
      ];
      const rollupConditions = [
        `r.project_id = ${project}`,
        `r.bucket_at >= date_trunc('hour', ${from}::timestamptz)`,
        `r.bucket_at < ${to}`,
        `eg.level = ANY(${severity}::log_level[])`,
      ];
      if (sides) {
        const side = parameters.addArray(sides);
        rawConditions.push(`eg.source = ANY(${side}::log_source[])`);
        rollupConditions.push(`eg.source = ANY(${side}::log_source[])`);
      }

      const result = await pool.query(
        `WITH counts AS (
           SELECT
             date_trunc('${bucket}', o.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
             COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
             COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
           FROM occurrences o
           JOIN error_groups eg ON eg.id = o.group_id
           WHERE ${rawConditions.join(" AND ")}
           GROUP BY bucket_at
           UNION ALL
           SELECT
             date_trunc('${bucket}', r.bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
             COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
             COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
           FROM occurrence_rollups_hourly r
           JOIN error_groups eg ON eg.id = r.group_id
           WHERE ${rollupConditions.join(" AND ")}
           GROUP BY bucket_at
         )
         SELECT
           bucket_at,
           SUM(client_count)::bigint AS client_count,
           SUM(server_count)::bigint AS server_count
         FROM counts
         GROUP BY bucket_at
         ORDER BY bucket_at`,
        parameters.values,
      );
      const counts = new Map(
        result.rows.map((row) => [
          new Date(row.bucket_at).getTime(),
          {
            clientCount: Number(row.client_count),
            serverCount: Number(row.server_count),
          },
        ]),
      );

      const data = Array.from({ length: bucketCount }, (_, index) => {
        const start = firstBucket + index * bucketMs;
        const count = counts.get(start);
        return {
          startAt: new Date(start).toISOString(),
          endAt: new Date(start + bucketMs).toISOString(),
          clientCount: count?.clientCount ?? 0,
          serverCount: count?.serverCount ?? 0,
        };
      });

      cache(reply, 10);
      return { data };
    },
  );
}
