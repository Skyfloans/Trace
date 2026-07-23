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
  displayErrorImpactsReady,
  displayErrorRollupFiltersReady,
  displayErrorReadModelReady,
  liveErrorGroupRollupsReady,
} from "./rollups.js";
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
      const displayReadModelReady = await displayErrorReadModelReady(pool);
      const displayRollupFiltersReady = displayReadModelReady
        ? await displayErrorRollupFiltersReady(pool)
        : false;
      const rollupsReady = displayReadModelReady
        ? true
        : await liveErrorGroupRollupsReady(pool);
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const from = parameters.add(time.from);
      const to = parameters.add(time.to);
      const severity = parameters.addArray(severities);
      const side = sides ? parameters.addArray(sides) : null;
      const metadataConditions = [
        `eg.project_id = ${project}`,
        `eg.last_seen_at >= ${from}`,
        `eg.first_seen_at < ${to}`,
        `eg.level = ANY(${severity}::log_level[])`,
      ];
      if (side) {
        metadataConditions.push(
          `eg.source = ANY(${side}::log_source[])`,
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
      const complete = completeHourRange(time);
      const currentWindow = time.to.getTime() >= Date.now();
      let sql: string;
      if (
        displayReadModelReady &&
        !complete.hasRawEdges &&
        (sort === "count" || currentWindow)
      ) {
        const rowLimit = parameters.add(limit + 1);
        if (sort === "recent") {
          let cursorCondition = "";
          if (cursorValues) {
            cursorCondition = `AND (deg.last_seen_at, deg.fingerprint) < (
              ${parameters.add(cursorValues[1])},
              ${parameters.add(cursorValues[2])}
            )`;
          }
          sql = `WITH candidate_groups AS (
            SELECT
              deg.id AS display_group_id,
              deg.fingerprint AS group_id,
              deg.fingerprint,
              deg.level,
              deg.source,
              deg.normalized_message,
              deg.source_script,
              deg.last_seen_at AS cursor_last_seen_at
            FROM display_error_groups deg
            WHERE deg.project_id = ${project}
              AND deg.last_seen_at >= ${from}
              AND deg.first_seen_at < ${to}
              AND deg.level = ANY(${severity}::log_level[])
              ${side ? `AND deg.source = ANY(${side}::log_source[])` : ""}
              ${cursorCondition}
            ORDER BY deg.last_seen_at DESC, deg.fingerprint DESC
            LIMIT ${rowLimit}
          )
          SELECT
            candidate_groups.group_id,
            candidate_groups.fingerprint,
            candidate_groups.level,
            candidate_groups.source,
            candidate_groups.normalized_message,
            candidate_groups.source_script,
            SUM(r.event_count)::int AS event_count,
            MIN(r.first_seen_at) AS first_seen_at,
            MAX(r.last_seen_at) AS last_seen_at,
            candidate_groups.cursor_last_seen_at
          FROM candidate_groups
          JOIN display_error_rollups_hourly r
            ON r.project_id = ${project}
           AND r.display_group_id = candidate_groups.display_group_id
           AND r.bucket_at >= ${from}
           AND r.bucket_at < ${to}
          GROUP BY
            candidate_groups.display_group_id,
            candidate_groups.group_id,
            candidate_groups.fingerprint,
            candidate_groups.level,
            candidate_groups.source,
            candidate_groups.normalized_message,
            candidate_groups.source_script,
            candidate_groups.cursor_last_seen_at
          ORDER BY candidate_groups.cursor_last_seen_at DESC,
                   candidate_groups.group_id DESC`;
        } else {
          let cursorCondition = "";
          if (cursorValues) {
            cursorCondition = `WHERE (event_count, last_seen_at, ${displayRollupFiltersReady ? "display_group_id::text" : "group_id"}) < (
              ${parameters.add(cursorValues[0])},
              ${parameters.add(cursorValues[1])},
              ${parameters.add(cursorValues[2])}
            )`;
          }
          sql = displayRollupFiltersReady ? `WITH stats AS (
            SELECT
              r.display_group_id,
              SUM(r.event_count)::int AS event_count,
              MIN(r.first_seen_at) AS first_seen_at,
              MAX(r.last_seen_at) AS last_seen_at
            FROM display_error_rollups_hourly r
            WHERE r.project_id = ${project}
              AND r.bucket_at >= ${from}
              AND r.bucket_at < ${to}
              AND r.level = ANY(${severity}::log_level[])
              ${side ? `AND r.source = ANY(${side}::log_source[])` : ""}
            GROUP BY r.display_group_id
          ), paged AS (
            SELECT *
            FROM stats
            ${cursorCondition}
            ORDER BY event_count DESC,
                     last_seen_at DESC,
                     display_group_id::text DESC
            LIMIT ${rowLimit}
          )
          SELECT
            deg.fingerprint AS group_id,
            deg.fingerprint,
            deg.level,
            deg.source,
            deg.normalized_message,
            deg.source_script,
            paged.event_count,
            paged.first_seen_at,
            paged.last_seen_at,
            paged.display_group_id::text AS cursor_group_id
          FROM paged
          JOIN display_error_groups deg ON deg.id = paged.display_group_id
          ORDER BY paged.event_count DESC,
                   paged.last_seen_at DESC,
                   paged.display_group_id::text DESC` : `WITH stats AS (
            SELECT
              r.display_group_id,
              SUM(r.event_count)::int AS event_count,
              MIN(r.first_seen_at) AS first_seen_at,
              MAX(r.last_seen_at) AS last_seen_at
            FROM display_error_rollups_hourly r
            WHERE r.project_id = ${project}
              AND r.bucket_at >= ${from}
              AND r.bucket_at < ${to}
            GROUP BY r.display_group_id
          ), filtered AS (
            SELECT
              deg.fingerprint AS group_id,
              deg.fingerprint,
              deg.level,
              deg.source,
              deg.normalized_message,
              deg.source_script,
              stats.event_count,
              stats.first_seen_at,
              stats.last_seen_at
            FROM stats
            JOIN display_error_groups deg ON deg.id = stats.display_group_id
            WHERE deg.project_id = ${project}
              AND deg.level = ANY(${severity}::log_level[])
              ${side ? `AND deg.source = ANY(${side}::log_source[])` : ""}
          )
          SELECT *
          FROM filtered
          ${cursorCondition}
          ORDER BY event_count DESC, last_seen_at DESC, group_id DESC
          LIMIT ${rowLimit}`;
        }
      } else if (rollupsReady) {
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
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS group_id,
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS fingerprint,
            eg.level,
            eg.source,
            COALESCE(eg.display_message, eg.normalized_message) AS normalized_message,
            COALESCE(eg.display_source_script, eg.source_script) AS source_script,
            SUM(stats.event_count)::int AS event_count,
            MIN(stats.first_seen_at) AS first_seen_at,
            MAX(stats.last_seen_at) AS last_seen_at
          FROM stats
          JOIN error_groups eg ON eg.id = stats.group_id
          WHERE ${metadataConditions.join(" AND ")}
          GROUP BY
            COALESCE(eg.display_fingerprint, eg.fingerprint), eg.level, eg.source,
            COALESCE(eg.display_message, eg.normalized_message),
            COALESCE(eg.display_source_script, eg.source_script)
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
          groupCursorCondition = `HAVING (MAX(eg.last_seen_at), COALESCE(eg.display_fingerprint, eg.fingerprint))
            < (${parameters.add(cursorValues[1])}, ${parameters.add(cursorValues[2])})`;
        }
        const rowLimit = parameters.add(limit + 1);
        sql = `WITH candidate_groups AS (
          SELECT
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS group_id,
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS fingerprint,
            eg.level,
            eg.source,
            COALESCE(eg.display_message, eg.normalized_message) AS normalized_message,
            COALESCE(eg.display_source_script, eg.source_script) AS source_script,
            MAX(eg.last_seen_at) AS cursor_last_seen_at
          FROM error_groups eg
          WHERE ${metadataConditions.join(" AND ")}
          GROUP BY
            COALESCE(eg.display_fingerprint, eg.fingerprint), eg.level, eg.source,
            COALESCE(eg.display_message, eg.normalized_message),
            COALESCE(eg.display_source_script, eg.source_script)
          ${groupCursorCondition}
          ORDER BY cursor_last_seen_at DESC, COALESCE(eg.display_fingerprint, eg.fingerprint) DESC
          LIMIT ${rowLimit}
        )
        SELECT
          candidate_groups.*,
          group_stats.event_count,
          group_stats.first_seen_at,
          group_stats.last_seen_at
        FROM candidate_groups
        JOIN LATERAL (
          SELECT
            SUM(o.repeat_count)::int AS event_count,
            MIN(o.occurred_at) AS first_seen_at,
            MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
          FROM occurrences o
          JOIN error_groups occurrence_group ON occurrence_group.id = o.group_id
          WHERE o.project_id = ${project}
            AND COALESCE(occurrence_group.display_fingerprint, occurrence_group.fingerprint) = candidate_groups.group_id
            AND o.occurred_at >= ${from}
            AND o.occurred_at < ${to}
        ) group_stats ON group_stats.event_count IS NOT NULL
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
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS group_id,
            COALESCE(eg.display_fingerprint, eg.fingerprint) AS fingerprint,
            eg.level,
            eg.source,
            COALESCE(eg.display_message, eg.normalized_message) AS normalized_message,
            COALESCE(eg.display_source_script, eg.source_script) AS source_script,
            SUM(o.repeat_count)::int AS event_count,
            MIN(o.occurred_at) AS first_seen_at,
            MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
          FROM occurrences o
          JOIN error_groups eg ON eg.id = o.group_id
          WHERE o.project_id = ${project}
            AND o.occurred_at >= ${from}
            AND o.occurred_at < ${to}
            AND ${metadataConditions.join(" AND ")}
          GROUP BY
            COALESCE(eg.display_fingerprint, eg.fingerprint), eg.level, eg.source,
            COALESCE(eg.display_message, eg.normalized_message),
            COALESCE(eg.display_source_script, eg.source_script)
        ),
        paged AS (
          SELECT *
          FROM stats
          ${cursorCondition}
          ORDER BY event_count DESC, last_seen_at DESC, group_id DESC
          LIMIT ${rowLimit}
        )
        SELECT *
        FROM paged
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
                last.cursor_group_id ?? last.group_id,
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
      const displayReadModelReady = await displayErrorReadModelReady(pool);
      const displayImpactsReady = displayReadModelReady
        ? await displayErrorImpactsReady(pool)
        : false;

      const result = await pool.query(
        displayImpactsReady ? `WITH requested_group AS MATERIALIZED (
           SELECT
             id, fingerprint, level, source, normalized_message, source_script
           FROM display_error_groups
           WHERE project_id = $1 AND fingerprint = $2
         ),
         edge_bounds AS (
           SELECT
             now() - interval '3 days' AS cutoff,
             date_trunc('hour', now() - interval '3 days') + interval '1 hour'
               AS complete_from,
             date_trunc('hour', now()) AS complete_to
         ),
         counts AS (
           SELECT
             rollups.event_count,
             rollups.first_seen_at,
             rollups.last_seen_at
           FROM requested_group
           CROSS JOIN edge_bounds
           JOIN display_error_rollups_hourly rollups
             ON rollups.project_id = $1
            AND rollups.display_group_id = requested_group.id
            AND rollups.bucket_at >= edge_bounds.complete_from
            AND rollups.bucket_at < edge_bounds.complete_to
           UNION ALL
           SELECT
             SUM(occurrences.repeat_count)::bigint,
             MIN(occurrences.occurred_at),
             MAX(COALESCE(
               occurrences.last_occurred_at,
               occurrences.occurred_at
             ))
           FROM requested_group
           CROSS JOIN edge_bounds
           JOIN display_error_group_members members
             ON members.display_group_id = requested_group.id
           JOIN occurrences
             ON occurrences.project_id = $1
            AND occurrences.group_id = members.exact_group_id
            AND occurrences.occurred_at >= edge_bounds.cutoff
            AND (
              occurrences.occurred_at < edge_bounds.complete_from
              OR occurrences.occurred_at >= edge_bounds.complete_to
            )
           HAVING COUNT(*) > 0
         ),
         stats AS (
           SELECT
             COALESCE(SUM(event_count), 0)::int AS event_count,
             MIN(first_seen_at) AS first_seen_at,
             MAX(last_seen_at) AS last_seen_at
           FROM counts
         ),
         latest AS MATERIALIZED (
           SELECT occurrences.*
           FROM requested_group
           JOIN display_error_group_members members
             ON members.display_group_id = requested_group.id
           JOIN occurrences
             ON occurrences.project_id = $1
            AND occurrences.group_id = members.exact_group_id
            AND occurrences.occurred_at >= now() - interval '3 days'
           ORDER BY occurrences.occurred_at DESC, occurrences.id DESC
           LIMIT 1
         )
         SELECT
           stats.*,
           (SELECT COUNT(*)::int
            FROM display_error_group_players players
            WHERE players.project_id = $1
              AND players.display_group_id = requested_group.id
              AND players.last_seen_at >= now() - interval '3 days')
             AS affected_player_count,
           (SELECT COUNT(*)::int
            FROM display_error_group_jobs jobs
            WHERE jobs.project_id = $1
              AND jobs.display_group_id = requested_group.id
              AND jobs.last_seen_at >= now() - interval '3 days')
             AS affected_server_count,
           requested_group.fingerprint AS group_fingerprint,
           requested_group.level AS group_level,
           requested_group.source AS group_source,
           requested_group.normalized_message AS group_message,
           requested_group.source_script AS group_source_script,
           ${occurrenceSelect}
         FROM requested_group
         CROSS JOIN stats
         JOIN latest o ON true
         JOIN error_groups eg ON eg.id = o.group_id
         LEFT JOIN sessions s ON s.id = o.session_id`
        : `WITH matching AS (
           SELECT o.*
           FROM occurrences o
           ${displayReadModelReady ? `JOIN display_error_group_members member
             ON member.exact_group_id = o.group_id
           JOIN display_error_groups requested_group
             ON requested_group.id = member.display_group_id
            AND requested_group.project_id = $1` : `JOIN error_groups matching_group
             ON matching_group.id = o.group_id`}
           WHERE o.project_id = $1
             AND ${displayReadModelReady ? "requested_group.fingerprint" : "COALESCE(matching_group.display_fingerprint, matching_group.fingerprint)"} = $2
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
           ${displayReadModelReady ? "display_group.fingerprint" : "COALESCE(eg.display_fingerprint, eg.fingerprint)"} AS group_fingerprint,
           ${displayReadModelReady ? "display_group.level" : "eg.level"} AS group_level,
           ${displayReadModelReady ? "display_group.source" : "eg.source"} AS group_source,
           ${displayReadModelReady ? "display_group.normalized_message" : "COALESCE(eg.display_message, eg.normalized_message)"} AS group_message,
           ${displayReadModelReady ? "display_group.source_script" : "COALESCE(eg.display_source_script, eg.source_script)"} AS group_source_script,
           ${occurrenceSelect}
         FROM stats
         JOIN latest o ON true
         JOIN error_groups eg ON eg.id = o.group_id
         ${displayReadModelReady ? `JOIN display_error_group_members latest_member
           ON latest_member.exact_group_id = o.group_id
         JOIN display_error_groups display_group
           ON display_group.id = latest_member.display_group_id
          AND display_group.project_id = $1` : ""}
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
          fingerprint: row.group_fingerprint,
          severity: row.group_level,
          side: row.group_source,
          title: row.group_message,
          source: row.group_source_script,
          count: row.event_count,
          affectedPlayerCount: row.affected_player_count,
          affectedServerCount: row.affected_server_count,
          firstSeenAt: iso(row.first_seen_at),
          lastSeenAt: iso(row.last_seen_at),
          latestOccurrenceId: row.id,
        },
        latestOccurrence: {
          ...mapOccurrence(row),
          fingerprint: row.group_fingerprint,
        },
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
      const displayReadModelReady = await displayErrorReadModelReady(pool);
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
        `${displayReadModelReady ? "display_group.fingerprint" : "COALESCE(eg.display_fingerprint, eg.fingerprint)"} = ${parameters.add(fingerprint)}`,
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
         ${displayReadModelReady ? `JOIN display_error_group_members member
           ON member.exact_group_id = o.group_id
         JOIN display_error_groups display_group
           ON display_group.id = member.display_group_id` : ""}
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
        data: rows.map((row) => ({
          ...mapOccurrence(row),
          fingerprint: displayReadModelReady ? fingerprint : row.fingerprint,
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.occurred_at), last.id])
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/errors/:fingerprint/variants",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, fingerprint } = fingerprintParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const displayReadModelReady = await displayErrorReadModelReady(pool);
      const query = request.query as Record<string, unknown>;
      const time = parseTimeRange(
        typeof query.from === "string" ? query.from : undefined,
        typeof query.to === "string" ? query.to : undefined,
      );
      const limit = clampLimit(query.limit as string | undefined, 50, 100);
      const parameters = new QueryParameters();
      const project = parameters.add(projectId);
      const groupFingerprint = parameters.add(fingerprint);
      const from = parameters.add(time.from);
      const to = parameters.add(time.to);
      let cursorCondition = "";

      if (typeof query.cursor === "string") {
        const values = decodeCursor(query.cursor);
        if (
          values.length !== 2 ||
          typeof values[0] !== "string" ||
          typeof values[1] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
        cursorCondition = `WHERE (last_seen_at, message) < (
          ${parameters.add(values[0])}, ${parameters.add(values[1])}
        )`;
      }

      const result = await pool.query(
        `WITH variants AS (
           SELECT
             COALESCE(o.original_message, eg.normalized_message) AS message,
             SUM(o.repeat_count)::int AS event_count,
             MIN(o.occurred_at) AS first_seen_at,
             MAX(COALESCE(o.last_occurred_at, o.occurred_at)) AS last_seen_at
           FROM occurrences o
           JOIN error_groups eg ON eg.id = o.group_id
           ${displayReadModelReady ? `JOIN display_error_group_members member
             ON member.exact_group_id = o.group_id
           JOIN display_error_groups display_group
             ON display_group.id = member.display_group_id` : ""}
           WHERE o.project_id = ${project}
             AND ${displayReadModelReady ? "display_group.fingerprint" : "COALESCE(eg.display_fingerprint, eg.fingerprint)"} = ${groupFingerprint}
             AND o.occurred_at >= ${from}
             AND o.occurred_at < ${to}
           GROUP BY COALESCE(o.original_message, eg.normalized_message)
         )
         SELECT *
         FROM variants
         ${cursorCondition}
         ORDER BY last_seen_at DESC, message DESC
         LIMIT ${parameters.add(limit + 1)}`,
        parameters.values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      cache(reply);
      return {
        data: rows.map((row) => ({
          message: String(row.message),
          count: Number(row.event_count),
          firstSeenAt: iso(row.first_seen_at),
          lastSeenAt: iso(row.last_seen_at),
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.last_seen_at), String(last.message)])
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

      const displayReadModelReady = await displayErrorReadModelReady(pool);
      const displayRollupFiltersReady = displayReadModelReady
        ? await displayErrorRollupFiltersReady(pool)
        : false;
      const rollupsReady = displayReadModelReady
        ? true
        : await liveErrorGroupRollupsReady(pool);
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
          const displayFilterConditions = [
            `r.project_id = ${project}`,
            `r.bucket_at + interval '1 hour' > ${from}`,
            `r.bucket_at < ${to}`,
            `r.bucket_at >= ${completeFrom}`,
            `r.bucket_at < ${completeTo}`,
            `r.level = ANY(${severity}::log_level[])`,
          ];
          if (side) {
            displayFilterConditions.push(
              `r.source = ANY(${side}::log_source[])`,
            );
          }
          segments.push(displayRollupFiltersReady ? `SELECT
            date_trunc('${bucket}', r.bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
            COALESCE(SUM(r.event_count) FILTER (WHERE r.source = 'client'), 0)::bigint AS client_count,
            COALESCE(SUM(r.event_count) FILTER (WHERE r.source = 'server'), 0)::bigint AS server_count
          FROM display_error_rollups_hourly r
          WHERE ${displayFilterConditions.join(" AND ")}
          GROUP BY bucket_at` : displayReadModelReady ? `SELECT
            date_trunc('${bucket}', r.bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
            COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'client'), 0)::bigint AS client_count,
            COALESCE(SUM(r.event_count) FILTER (WHERE eg.source = 'server'), 0)::bigint AS server_count
          FROM display_error_rollups_hourly r
          JOIN display_error_groups eg ON eg.id = r.display_group_id
          WHERE ${rollupConditions.join(" AND ")}
          GROUP BY bucket_at` : `SELECT
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
