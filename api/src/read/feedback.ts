import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireProjectMembership } from "./auth.js";
import { clampLimit, decodeCursor, encodeCursor, iso, ReadApiError } from "./http.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

const projectParamsSchema = z.object({ projectId: z.uuid() });

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
): Promise<void> {
  app.get(
    "/v1/projects/:projectId/feedback",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const query = request.query as Record<string, unknown>;
      const limit = clampLimit(query.limit as string | undefined, 25, 100);
      const values: unknown[] = [projectId];
      let cursorCondition = "";

      if (typeof query.cursor === "string") {
        const cursor = decodeCursor(query.cursor);
        if (
          cursor.length !== 2 ||
          typeof cursor[0] !== "string" ||
          typeof cursor[1] !== "string"
        ) {
          throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
        }
        values.push(cursor[0], cursor[1]);
        cursorCondition = "AND (f.submitted_at, f.id) < ($2, $3)";
      }
      values.push(limit + 1);

      const result = await pool.query(
        `SELECT
           f.id, f.message, f.submitted_at, f.session_id,
           f.player_id, s.player_name, s.player_display_name,
           s.device, s.platform
         FROM feedback f
         LEFT JOIN sessions s ON s.id = f.session_id
         WHERE f.project_id = $1
           ${cursorCondition}
         ORDER BY f.submitted_at DESC, f.id DESC
         LIMIT $${values.length}`,
        values,
      );

      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      reply.header("Cache-Control", "private, max-age=5, stale-while-revalidate=15");
      return {
        data: rows.map((row) => ({
          id: row.id,
          message: row.message,
          submittedAt: iso(row.submitted_at),
          sessionId: row.session_id,
          player: {
            robloxUserId: String(row.player_id),
            username: row.player_name ?? `User ${row.player_id}`,
            displayName: row.player_display_name ?? row.player_name ?? `User ${row.player_id}`,
            avatarUrl: null,
          },
          device: row.device ?? row.platform ?? null,
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([iso(last.submitted_at), last.id])
            : null,
      };
    },
  );
}
