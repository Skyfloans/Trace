import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { MAX_AUTOFIX_PROPOSALS } from "../roblox-autofix.js";
import { ReadApiError } from "./http.js";
import { loadPluginSession } from "./roblox-plugin-auth.js";

const proposalParamsSchema = z.object({ proposalId: z.uuid() });
const createRunSchema = z.object({
  limit: z.number().int().min(1).max(MAX_AUTOFIX_PROPOSALS).default(15),
});
const reviewSchema = z.object({
  action: z.enum(["accepted", "rejected", "conflict"]),
  message: z.string().trim().max(500).optional(),
});

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

export async function registerRobloxAutofixRoutes(
  app: FastifyInstance,
  pool: Pool,
  model: string,
  available: boolean,
): Promise<void> {
  app.get("/v1/plugin-autofix/proposals", async (request, reply) => {
    const session = await loadPluginSession(pool, request);
    const [runResult, proposalResult] = await Promise.all([
      pool.query(
        `SELECT id, status, max_proposals, input_tokens, output_tokens,
                started_at, finished_at, last_error, created_at
         FROM roblox_autofix_runs
         WHERE project_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [session.project_id],
      ),
      pool.query(
        `SELECT proposal.id, proposal.run_id, proposal.status,
                proposal.priority_rank, proposal.ai_category::text,
                proposal.title, proposal.summary, proposal.confidence,
                proposal.risk, proposal.failure_reason,
                proposal.created_at, proposal.updated_at,
                error.normalized_message, error.source_script,
                error.level::text, error.source::text,
                COALESCE(impact.event_count, 0)::int AS event_count,
                COUNT(file.id)::int AS file_count
         FROM roblox_autofix_proposals proposal
         JOIN display_error_groups error ON error.id = proposal.error_group_id
         LEFT JOIN LATERAL (
           SELECT SUM(rollup.event_count)::int AS event_count
           FROM display_error_rollups_hourly rollup
           WHERE rollup.project_id = proposal.project_id
             AND rollup.display_group_id = proposal.error_group_id
         ) impact ON true
         LEFT JOIN roblox_autofix_files file ON file.proposal_id = proposal.id
         WHERE proposal.project_id = $1
           AND proposal.status NOT IN ('accepted', 'rejected')
         GROUP BY proposal.id, error.id, impact.event_count
         ORDER BY
           CASE proposal.status
             WHEN 'ready' THEN 0
             WHEN 'conflict' THEN 1
             WHEN 'processing' THEN 2
             WHEN 'queued' THEN 3
             ELSE 4
           END,
           proposal.created_at DESC,
           proposal.priority_rank
         LIMIT 100`,
        [session.project_id],
      ),
    ]);
    noStore(reply);
    const run = runResult.rows[0];
    return {
      available,
      run: run
        ? {
            id: run.id,
            status: run.status,
            maxProposals: Number(run.max_proposals),
            inputTokens: Number(run.input_tokens),
            outputTokens: Number(run.output_tokens),
            startedAt: run.started_at ? iso(run.started_at) : null,
            finishedAt: run.finished_at ? iso(run.finished_at) : null,
            error: run.last_error,
            createdAt: iso(run.created_at),
          }
        : null,
      proposals: proposalResult.rows.map((proposal) => ({
        id: proposal.id,
        runId: proposal.run_id,
        status: proposal.status,
        priorityRank: Number(proposal.priority_rank),
        category: proposal.ai_category,
        title: proposal.title,
        summary: proposal.summary,
        confidence:
          proposal.confidence === null ? null : Number(proposal.confidence),
        risk: proposal.risk,
        failureReason: proposal.failure_reason,
        message: proposal.normalized_message,
        sourceScript: proposal.source_script,
        severity: proposal.level,
        side: proposal.source,
        eventCount: Number(proposal.event_count),
        fileCount: Number(proposal.file_count),
        createdAt: iso(proposal.created_at),
        updatedAt: iso(proposal.updated_at),
      })),
    };
  });

  app.post(
    "/v1/plugin-autofix/runs",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          hook: "preHandler",
        },
      },
    },
    async (request, reply) => {
      const session = await loadPluginSession(pool, request);
      if (!available) {
        throw new ReadApiError(
          503,
          "autofix_not_configured",
          "Trace Autofix requires OpenRouter and place snapshot storage.",
        );
      }
      const { limit } = createRunSchema.parse(request.body ?? {});
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`roblox-autofix:${session.project_id}`],
        );
        const active = await client.query(
          `SELECT id, status, created_at
           FROM roblox_autofix_runs
           WHERE project_id = $1 AND status IN ('queued', 'processing')
           ORDER BY created_at DESC
           LIMIT 1`,
          [session.project_id],
        );
        if (active.rows[0]) {
          await client.query("COMMIT");
          noStore(reply);
          return reply.code(200).send({
            created: false,
            run: {
              id: active.rows[0].id,
              status: active.rows[0].status,
              createdAt: iso(active.rows[0].created_at),
            },
          });
        }

        const outstanding = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM roblox_autofix_proposals
           WHERE project_id = $1
             AND status IN ('queued', 'processing', 'ready', 'conflict')`,
          [session.project_id],
        );
        const remainingCapacity =
          MAX_AUTOFIX_PROPOSALS - Number(outstanding.rows[0]?.count ?? 0);
        if (remainingCapacity <= 0) {
          await client.query("COMMIT");
          noStore(reply);
          return reply.code(200).send({
            created: false,
            reason: "review_capacity_reached",
          });
        }

        const snapshot = await client.query<{ id: string }>(
          `SELECT id
           FROM roblox_place_snapshots
           WHERE project_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [session.project_id],
        );
        const snapshotId = snapshot.rows[0]?.id;
        if (!snapshotId) {
          throw new ReadApiError(
            409,
            "autofix_snapshot_required",
            "Sync the latest Roblox place on Trace before preparing fixes.",
          );
        }

        const candidates = await client.query<{
          error_group_id: string;
          ai_category: "critical" | "high" | "medium" | "low";
        }>(
          `WITH impact AS (
             SELECT display_group_id, SUM(event_count)::bigint AS event_count
             FROM display_error_rollups_hourly
             WHERE project_id = $1
             GROUP BY display_group_id
           )
           SELECT error.id AS error_group_id, error.ai_category::text
           FROM display_error_groups error
           LEFT JOIN impact ON impact.display_group_id = error.id
           WHERE error.project_id = $1
             AND error.ai_category IN ('critical', 'high', 'medium', 'low')
             AND NOT EXISTS (
               SELECT 1
               FROM roblox_autofix_proposals existing
               WHERE existing.snapshot_id = $2
                 AND existing.error_group_id = error.id
             )
           ORDER BY
             CASE error.ai_category
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'medium' THEN 2
               WHEN 'low' THEN 3
             END,
             COALESCE(impact.event_count, 0) DESC,
             error.last_seen_at DESC,
             error.id
           LIMIT $3`,
          [session.project_id, snapshotId, Math.min(limit, remainingCapacity)],
        );
        if (candidates.rows.length === 0) {
          await client.query("COMMIT");
          noStore(reply);
          return reply.code(200).send({
            created: false,
            reason: "no_eligible_bugs",
          });
        }

        const runResult = await client.query<{ id: string; created_at: unknown }>(
          `INSERT INTO roblox_autofix_runs (
             project_id, snapshot_id, requested_by_credential_id,
             max_proposals, model
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [
            session.project_id,
            snapshotId,
            session.credential_id,
            Math.min(limit, remainingCapacity),
            model,
          ],
        );
        const run = runResult.rows[0]!;
        for (const [index, candidate] of candidates.rows.entries()) {
          await client.query(
            `INSERT INTO roblox_autofix_proposals (
               run_id, project_id, snapshot_id, error_group_id,
               priority_rank, ai_category, model
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              run.id,
              session.project_id,
              snapshotId,
              candidate.error_group_id,
              index + 1,
              candidate.ai_category,
              model,
            ],
          );
        }
        await client.query("COMMIT");
        noStore(reply);
        return reply.code(201).send({
          created: true,
          run: {
            id: run.id,
            status: "queued",
            proposalCount: candidates.rows.length,
            createdAt: iso(run.created_at),
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/v1/plugin-autofix/proposals/:proposalId",
    async (request, reply) => {
      const session = await loadPluginSession(pool, request);
      const { proposalId } = proposalParamsSchema.parse(request.params);
      const result = await pool.query(
        `SELECT proposal.id, proposal.status, proposal.ai_category::text,
                proposal.title, proposal.summary, proposal.confidence,
                proposal.risk, proposal.failure_reason,
                error.normalized_message, error.source_script,
                error.level::text, error.source::text,
                file.id AS file_id, file.script_path, file.script_class,
                file.base_source_sha256, file.base_source,
                file.proposed_source, file.patch
         FROM roblox_autofix_proposals proposal
         JOIN display_error_groups error ON error.id = proposal.error_group_id
         LEFT JOIN roblox_autofix_files file ON file.proposal_id = proposal.id
         WHERE proposal.id = $1 AND proposal.project_id = $2
         ORDER BY file.script_path`,
        [proposalId, session.project_id],
      );
      if (result.rows.length === 0) {
        throw new ReadApiError(
          404,
          "autofix_proposal_not_found",
          "This fix proposal is no longer available.",
        );
      }
      const first = result.rows[0]!;
      noStore(reply);
      return {
        id: first.id,
        status: first.status,
        category: first.ai_category,
        title: first.title,
        summary: first.summary,
        confidence:
          first.confidence === null ? null : Number(first.confidence),
        risk: first.risk,
        failureReason: first.failure_reason,
        bug: {
          message: first.normalized_message,
          sourceScript: first.source_script,
          severity: first.level,
          side: first.source,
        },
        files: result.rows.flatMap((row) =>
          row.file_id
            ? [{
                id: row.file_id,
                path: row.script_path,
                className: row.script_class,
                baseSha256: row.base_source_sha256,
                baseSource: row.base_source,
                proposedSource: row.proposed_source,
                patch: row.patch,
              }]
            : []
        ),
      };
    },
  );

  app.post(
    "/v1/plugin-autofix/proposals/:proposalId/review",
    async (request, reply) => {
      const session = await loadPluginSession(pool, request);
      const { proposalId } = proposalParamsSchema.parse(request.params);
      const body = reviewSchema.parse(request.body);
      const allowedCurrent =
        body.action === "accepted"
          ? ["ready", "conflict"]
          : body.action === "rejected"
            ? ["ready", "conflict"]
            : ["ready"];
      const result = await pool.query(
        `UPDATE roblox_autofix_proposals
         SET status = $3,
             reviewed_by_credential_id = $4,
             reviewed_at = CASE
               WHEN $3 IN ('accepted', 'rejected') THEN now()
               ELSE reviewed_at
             END,
             failure_reason = CASE
               WHEN $3 = 'conflict' THEN COALESCE($5, 'Studio source changed near the proposed edit.')
               WHEN $3 IN ('accepted', 'rejected') THEN NULL
               ELSE failure_reason
             END,
             updated_at = now()
         WHERE id = $1
           AND project_id = $2
           AND status = ANY($6::text[])
         RETURNING id, status, reviewed_at`,
        [
          proposalId,
          session.project_id,
          body.action,
          session.credential_id,
          body.message ?? null,
          allowedCurrent,
        ],
      );
      if (!result.rows[0]) {
        throw new ReadApiError(
          409,
          "autofix_review_invalid",
          "This proposal cannot be reviewed from its current state.",
        );
      }
      noStore(reply);
      return {
        id: result.rows[0].id,
        status: result.rows[0].status,
        reviewedAt: result.rows[0].reviewed_at
          ? iso(result.rows[0].reviewed_at)
          : null,
      };
    },
  );
}
