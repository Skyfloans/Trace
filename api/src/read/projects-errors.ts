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
import { liveErrorGroupRollupsReady } from "./rollups.js";
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

const hourMs = 60 * 60 * 1_000;

function completeHourRange(time: { from: Date; to: Date }): {
  from: Date;
  to: Date;
  hasCompleteHours: boolean;
  hasRawEdges: boolean;
} {
  const fromTime = time.from.getTime();
  const toTime = time.to.getTime();
  const completeFrom = Math.ceil(fromTime / hourMs) * hourMs;
  const completeTo = Math.floor(toTime / hourMs) * hourMs;
  const hasCompleteHours = completeFrom < completeTo;
  return {
    from: new Date(completeFrom),
    to: new Date(completeTo),
    hasCompleteHours,
    hasRawEdges:
      !hasCompleteHours || fromTime < completeFrom || completeTo < toTime,
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

      reply.header("Cache-Control", "private, no-store");
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
      const limit = clampLimit(query.limit as string | undefined, 50, 100);
      const sort = z
        .enum(["count", "recent"])
        .parse(typeof query.sort === "string" ? query.sort : "count");
      const rollupsReady = await liveErrorGroupRollupsReady(pool);
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const from = parameters.add(time.from);
      const to = parameters.add(time.to);
      const severity = parameters.addArray(severities);
      const metadataConditions = [
        `eg.project_id = ${project}`,
        `eg.last_seen_at >= ${from}`,
        `eg.first_seen_at < ${to}`,
        `eg.level = ANY(${severity}::log_level[])`,
      ];
      if (sides) {
        metadataConditions.push(
          `eg.source = ANY(${parameters.addArray(sides)}::log_source[])`,
        );
      }

      let cursorValues: Array<string | number | null> | null = null;
      if (typeof query.cursor === "string") {
        cursorValues = decodeCursor(query.cursor);
        if (
          cursorValues.length !== 3 ||
          typeof cursorValues[0] !== "number" ||
          typeof cursorValues[1] !== "string" ||
          typeof cursorValues[2] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
      }
      let sql: string;
      if (rollupsReady) {
        const complete = completeHourRange(time);
        const completeFrom = parameters.add(complete.from);
        const completeTo = parameters.add(complete.to);
        const segments: string[] = [];
        if (complete.hasCompleteHours) {
          segments.push(`SELECT
            r.group_id,
            r.event_count,
            r.first_seen_at,
            r.last_seen_at
          FROM occurrence_rollups_hourly r
          WHERE r.project_id = ${project}
            AND r.bucket_at >= ${completeFrom}
            AND r.bucket_at < ${completeTo}`);
        }
        if (complete.hasRawEdges) {
          const excludeCompleteHours = complete.hasCompleteHours
            ? `AND NOT (
              o.occurred_at >= ${completeFrom}
              AND o.occurred_at < ${completeTo}
            )`
            : "";
          segments.push(`SELECT
            o.group_id,
            SUM(o.repeat_count)::bigint AS event_count,
            MIN(o.occurred_at) AS first_seen_at,
            MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
          FROM occurrences o
          WHERE o.project_id = ${project}
            AND o.occurred_at >= ${from}
            AND o.occurred_at < ${to}
            ${excludeCompleteHours}
          GROUP BY o.group_id`);
        }
        let cursorCondition = "";
        if (cursorValues) {
          cursorCondition = sort === "recent"
            ? `WHERE (last_seen_at, group_id) < (${parameters.add(cursorValues[1])}, ${parameters.add(cursorValues[2])})`
            : `WHERE (event_count, last_seen_at, group_id) < (${parameters.add(cursorValues[0])}, ${parameters.add(cursorValues[1])}, ${parameters.add(cursorValues[2])})`;
        }
        const rowLimit = parameters.add(limit + 1);
        const order = sort === "recent"
          ? "last_seen_at DESC, group_id DESC"
          : "event_count DESC, last_seen_at DESC, group_id DESC";
        sql = `WITH combined AS (
          ${segments.join("\n          UNION ALL\n          ")}
        ),
        stats AS (
          SELECT
            group_id,
            SUM(event_count)::int AS event_count,
            MIN(first_seen_at) AS first_seen_at,
            MAX(last_seen_at) AS last_seen_at
          FROM combined
          GROUP BY group_id
        ),
        filtered AS (
          SELECT
            stats.*,
            eg.fingerprint,
            eg.level,
            eg.source,
            eg.normalized_message,
            eg.source_script
          FROM stats
          JOIN error_groups eg ON eg.id = stats.group_id
          WHERE ${metadataConditions.join(" AND ")}
        ),
        paged AS (
          SELECT *
          FROM filtered
          ${cursorCondition}
          ORDER BY ${order}
          LIMIT ${rowLimit}
        )
        SELECT *
        FROM paged
        ORDER BY ${order}`;
      } else if (sort === "recent") {
        let groupCursorCondition = "";
        if (cursorValues) {
          groupCursorCondition = `AND (eg.last_seen_at, eg.id)
            < (${parameters.add(cursorValues[1])}, ${parameters.add(cursorValues[2])})`;
        }
        const rowLimit = parameters.add(limit + 1);
        sql = `WITH candidate_groups AS (
          SELECT
            eg.id AS group_id,
            eg.last_seen_at AS cursor_last_seen_at
          FROM error_groups eg
          WHERE ${metadataConditions.join(" AND ")}
            ${groupCursorCondition}
          ORDER BY eg.last_seen_at DESC, eg.id DESC
          LIMIT ${rowLimit}
        )
        SELECT
          candidate_groups.group_id,
          candidate_groups.cursor_last_seen_at,
          group_stats.event_count,
          group_stats.first_seen_at,
          group_stats.last_seen_at,
          eg.fingerprint,
          eg.level,
          eg.source,
          eg.normalized_message,
          eg.source_script
        FROM candidate_groups
        JOIN LATERAL (
          SELECT
            SUM(o.repeat_count)::int AS event_count,
            MIN(o.occurred_at) AS first_seen_at,
            MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
          FROM occurrences o
          WHERE o.project_id = ${project}
            AND o.group_id = candidate_groups.group_id
            AND o.occurred_at >= ${from}
            AND o.occurred_at < ${to}
        ) group_stats ON group_stats.event_count IS NOT NULL
        JOIN error_groups eg ON eg.id = candidate_groups.group_id
        ORDER BY candidate_groups.cursor_last_seen_at DESC, candidate_groups.group_id DESC`;
      } else {
        let cursorCondition = "";
        if (cursorValues) {
          cursorCondition = `WHERE (event_count, last_seen_at, group_id)
            < (${parameters.add(cursorValues[0])}, ${parameters.add(cursorValues[1])}, ${parameters.add(cursorValues[2])})`;
        }
        const rowLimit = parameters.add(limit + 1);
        sql = `WITH stats AS (
          SELECT
            o.group_id,
            SUM(o.repeat_count)::int AS event_count,
            MIN(o.occurred_at) AS first_seen_at,
            MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
          FROM occurrences o
          JOIN error_groups eg ON eg.id = o.group_id
          WHERE o.project_id = ${project}
            AND o.occurred_at >= ${from}
            AND o.occurred_at < ${to}
            AND ${metadataConditions.join(" AND ")}
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
          paged.*,
          eg.fingerprint,
          eg.level,
          eg.source,
          eg.normalized_message,
          eg.source_script
        FROM paged
        JOIN error_groups eg ON eg.id = paged.group_id
        ORDER BY paged.event_count DESC, paged.last_seen_at DESC, paged.group_id DESC`;
      }

      const result = await pool.query(sql, parameters.values);

      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply, 10);
      return {
        data: rows.map((row) => ({
          fingerprint: row.fingerprint,
          severity: row.level,
          side: row.source,
          title: row.normalized_message,
          source: row.source_script,
          count: Number(row.event_count),
          firstSeenAt: iso(row.first_seen_at),
          lastSeenAt: iso(row.last_seen_at),
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([
                Number(last.event_count),
                iso(last.cursor_last_seen_at ?? last.last_seen_at),
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

      const rollupsReady = await liveErrorGroupRollupsReady(pool);
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
      const side = sides ? parameters.addArray(sides) : null;
      if (side) rawConditions.push(`eg.source = ANY(${side}::log_source[])`);

      let sql: string;
      if (rollupsReady) {
        const complete = completeHourRange(time);
        const completeFrom = parameters.add(complete.from);
        const completeTo = parameters.add(complete.to);
        const segments: string[] = [];
        if (complete.hasRawEdges) {
          const edgeConditions = [...rawConditions];
          if (complete.hasCompleteHours) {
            edgeConditions.push(`NOT (
              o.occurred_at >= ${completeFrom}
              AND o.occurred_at < ${completeTo}
            )`);
          }
          segments.push(`SELECT
            date_trunc('${bucket}', o.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
            COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
            COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
          FROM occurrences o
          JOIN error_groups eg ON eg.id = o.group_id
          WHERE ${edgeConditions.join(" AND ")}
          GROUP BY bucket_at`);
        }
        if (complete.hasCompleteHours) {
          const rollupConditions = [
            `r.project_id = ${project}`,
            `r.bucket_at + interval '1 hour' > ${from}`,
            `r.bucket_at < ${to}`,
            `r.bucket_at >= ${completeFrom}`,
            `r.bucket_at < ${completeTo}`,
            `eg.level = ANY(${severity}::log_level[])`,
          ];
          if (side) {
            rollupConditions.push(`eg.source = ANY(${side}::log_source[])`);
          }
          segments.push(`SELECT
            date_trunc('${bucket}', r.bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
            COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
            COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
          FROM occurrence_rollups_hourly r
          JOIN error_groups eg ON eg.id = r.group_id
          WHERE ${rollupConditions.join(" AND ")}
          GROUP BY bucket_at`);
        }
        sql = `WITH counts AS (
          ${segments.join("\n          UNION ALL\n          ")}
          )
          SELECT
            bucket_at,
            SUM(client_count)::bigint AS client_count,
            SUM(server_count)::bigint AS server_count
          FROM counts
          GROUP BY bucket_at
          ORDER BY bucket_at`;
      } else {
        sql = `SELECT
          date_trunc('${bucket}', o.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
          COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
          COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
        FROM occurrences o
        JOIN error_groups eg ON eg.id = o.group_id
        WHERE ${rawConditions.join(" AND ")}
        GROUP BY bucket_at
        ORDER BY bucket_at`;
      }

      const result = await pool.query(sql, parameters.values);
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
