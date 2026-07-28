import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { structuredPatch } from "diff";
import type { FastifyBaseLogger } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ArchiveStorage } from "./archive-storage.js";
import {
  extractScriptsFromPlace,
  type PlaceScript,
} from "./roblox-place-parser.js";

const AUTOFIX_SYSTEM_PROMPT = readFileSync(
  new URL("../AUTOFIX_AGENT.md", import.meta.url),
  "utf8",
);

export const MAX_AUTOFIX_PROPOSALS = 15;
export const AUTOFIX_SCHEDULE_INTERVAL_MS = 10 * 60 * 1_000;
const MAX_CHANGED_SCRIPTS = 3;
const MAX_CONTEXT_SCRIPTS = 8;
const MAX_SCRIPT_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 80_000;
const MAX_OUTPUT_TOKENS = 5_000;
const MAX_RUN_INPUT_TOKENS = 120_000;
const MAX_RUN_OUTPUT_TOKENS = 45_000;
const MIN_CONFIDENCE = 0.8;

type AutofixRun = {
  id: string;
  project_id: string;
  snapshot_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  object_key: string;
  sha256: string;
};

type AutofixProposal = {
  id: string;
  error_group_id: string;
  normalized_message: string;
  normalized_stack: string | null;
  source_script: string | null;
  level: string;
  source: string;
  ai_category: "critical" | "high" | "medium" | "low";
};

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

const modelResultSchema = z.object({
  outcome: z.enum(["fixed", "unable"]),
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(400),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  reason: z.string().trim().min(1).max(300).optional(),
  changes: z.array(z.object({
    path: z.string().trim().min(1).max(1_000),
    proposedSource: z.string().max(1_000_000),
  })).max(MAX_CHANGED_SCRIPTS),
});

const openRouterResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type AutofixWorkerOptions = {
  pool: Pool;
  storage: ArchiveStorage;
  apiKey: string;
  model: string;
  webOrigin: string;
  pollIntervalMs?: number;
  fetchImplementation?: typeof fetch;
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

export type AutofixSchedulerOptions = {
  pool: Pool;
  model: string;
  intervalMs?: number;
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

function parseStructuredContent(content: string): unknown {
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("OpenRouter returned no JSON object");
  }
  return JSON.parse(content.slice(firstBrace, lastBrace + 1));
}

function normalizePath(value: string): string {
  return value
    .replace(/^.*?['"]([^'"]+)['"].*$/, "$1")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/\//g, ".")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function pathSegments(value: string): string[] {
  return normalizePath(value).split(".").filter(Boolean);
}

function suffixMatches(path: string, source: string): boolean {
  const left = pathSegments(path);
  const right = pathSegments(source);
  if (right.length === 0 || right.length > left.length) return false;
  return right.every(
    (segment, index) => segment === left[left.length - right.length + index],
  );
}

export function findTargetScript(
  scripts: PlaceScript[],
  sourceScript: string | null,
  stack: string | null,
): PlaceScript | null {
  if (sourceScript) {
    const exact = scripts.filter(
      (script) => normalizePath(script.path) === normalizePath(sourceScript),
    );
    if (exact.length === 1) return exact[0]!;
    const suffix = scripts.filter((script) =>
      suffixMatches(script.path, sourceScript)
    );
    if (suffix.length === 1) return suffix[0]!;
  }

  const evidence = `${sourceScript ?? ""}\n${stack ?? ""}`.toLowerCase();
  const scored = scripts
    .map((script) => {
      const path = script.path.toLowerCase();
      const name = script.name.toLowerCase();
      let score = evidence.includes(path) ? 10 : 0;
      if (name.length >= 3 && evidence.includes(name)) score += 3;
      return { script, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored[0] || scored[1]?.score === scored[0].score) return null;
  return scored[0].script;
}

function contextFor(
  scripts: PlaceScript[],
  target: PlaceScript,
  proposal: AutofixProposal,
): PlaceScript[] {
  if (target.source.length > MAX_SCRIPT_CHARS) return [];
  const evidence = [
    target.source,
    proposal.normalized_message,
    proposal.normalized_stack ?? "",
  ].join("\n").toLowerCase();
  const targetParent = target.path.split(".").slice(0, -1).join(".");
  const candidates = scripts
    .filter((script) => script.path !== target.path)
    .filter((script) => script.source.length <= MAX_SCRIPT_CHARS)
    .map((script) => {
      let score = 0;
      if (evidence.includes(script.path.toLowerCase())) score += 12;
      if (script.name.length >= 3 && evidence.includes(script.name.toLowerCase())) {
        score += 5;
      }
      if (
        targetParent &&
        script.path.startsWith(`${targetParent}.`)
      ) {
        score += 1;
      }
      return { script, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score || left.script.path.localeCompare(right.script.path)
    );

  const selected = [target];
  let characters = target.source.length;
  for (const { script } of candidates) {
    if (selected.length >= MAX_CONTEXT_SCRIPTS) break;
    if (characters + script.source.length > MAX_CONTEXT_CHARS) continue;
    selected.push(script);
    characters += script.source.length;
  }
  return selected;
}

function responseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "roblox_autofix_proposal",
      strict: true,
      schema: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["fixed", "unable"] },
          title: { type: "string", minLength: 1, maxLength: 80 },
          summary: { type: "string", minLength: 1, maxLength: 400 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          reason: { type: "string", minLength: 1, maxLength: 300 },
          changes: {
            type: "array",
            maxItems: MAX_CHANGED_SCRIPTS,
            items: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 1_000 },
                proposedSource: { type: "string", maxLength: 1_000_000 },
              },
              required: ["path", "proposedSource"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "outcome",
          "title",
          "summary",
          "confidence",
          "risk",
          "reason",
          "changes",
        ],
        additionalProperties: false,
      },
    },
  };
}

async function requestFix(
  options: AutofixWorkerOptions,
  proposal: AutofixProposal,
  context: PlaceScript[],
  remainingInputTokens: number,
  remainingOutputTokens: number,
): Promise<{
  result: z.infer<typeof modelResultSchema>;
  usage: OpenRouterUsage;
  estimatedInputTokens: number;
}> {
  const userContent = JSON.stringify({
    bug: {
      category: proposal.ai_category,
      severity: proposal.level,
      side: proposal.source,
      message: proposal.normalized_message,
      sourceScript: proposal.source_script,
      stackTrace: proposal.normalized_stack,
    },
    scripts: context.map((script) => ({
      path: script.path,
      className: script.className,
      source: script.source,
    })),
  });
  const estimatedInputTokens = Math.ceil(
    (AUTOFIX_SYSTEM_PROMPT.length + userContent.length) / 4,
  );
  if (estimatedInputTokens > remainingInputTokens) {
    throw new Error("autofix_input_budget_exhausted");
  }
  if (remainingOutputTokens < 500) {
    throw new Error("autofix_output_budget_exhausted");
  }
  const fetcher = options.fetchImplementation ?? fetch;
  const response = await fetcher(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "HTTP-Referer": options.webOrigin,
        "X-Title": "Trace Autofix",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: AUTOFIX_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: responseFormat(),
        reasoning: { enabled: false, exclude: true },
        temperature: 0,
        max_completion_tokens: Math.min(
          MAX_OUTPUT_TOKENS,
          remainingOutputTokens,
        ),
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`OpenRouter returned ${response.status}: ${body}`);
  }
  const completion = openRouterResponseSchema.parse(await response.json());
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("OpenRouter returned no autofix content");
  return {
    result: modelResultSchema.parse(parseStructuredContent(content)),
    usage: completion.usage ?? {},
    estimatedInputTokens,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function patchFor(path: string, baseSource: string, proposedSource: string) {
  const patch = structuredPatch(
    path,
    path,
    baseSource,
    proposedSource,
    "snapshot",
    "proposed",
    { context: 3 },
  );
  return {
    hunks: patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
      oldBlock: hunk.lines
        .filter((line) => !line.startsWith("+") && line !== "\\ No newline at end of file")
        .map((line) => line.slice(1)),
      newBlock: hunk.lines
        .filter((line) => !line.startsWith("-") && line !== "\\ No newline at end of file")
        .map((line) => line.slice(1)),
    })),
  };
}

async function claimRun(pool: Pool): Promise<AutofixRun | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<AutofixRun>(
      `SELECT run.id, run.project_id, run.snapshot_id, run.model,
              run.input_tokens, run.output_tokens,
              snapshot.object_key, snapshot.sha256
       FROM roblox_autofix_runs run
       JOIN roblox_place_snapshots snapshot ON snapshot.id = run.snapshot_id
       WHERE run.status = 'queued'
       ORDER BY run.created_at, run.id
       FOR UPDATE OF run SKIP LOCKED
       LIMIT 1`,
    );
    const run = result.rows[0];
    if (!run) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE roblox_autofix_runs
       SET status = 'processing', started_at = COALESCE(started_at, now())
       WHERE id = $1`,
      [run.id],
    );
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadProposals(
  pool: Pool,
  runId: string,
): Promise<AutofixProposal[]> {
  const result = await pool.query<AutofixProposal>(
    `SELECT proposal.id, proposal.error_group_id,
            error.normalized_message,
            representative.normalized_stack,
            error.source_script, error.level::text, error.source::text,
            proposal.ai_category::text
     FROM roblox_autofix_proposals proposal
     JOIN display_error_groups error ON error.id = proposal.error_group_id
     LEFT JOIN LATERAL (
       SELECT exact.normalized_stack
       FROM display_error_group_members member
       JOIN error_groups exact ON exact.id = member.exact_group_id
       WHERE member.display_group_id = error.id
       ORDER BY exact.last_seen_at DESC
       LIMIT 1
     ) representative ON true
     WHERE proposal.run_id = $1
       AND proposal.status = 'queued'
     ORDER BY proposal.priority_rank, proposal.created_at, proposal.id`,
    [runId],
  );
  return result.rows;
}

async function markUnable(
  queryable: Pool | PoolClient,
  proposalId: string,
  reason: string,
  details?: {
    confidence?: number;
    inputTokens?: number;
    outputTokens?: number;
    risk?: "low" | "medium" | "high";
    summary?: string;
    title?: string;
  },
): Promise<void> {
  await queryable.query(
    `UPDATE roblox_autofix_proposals
     SET status = 'unable',
         title = COALESCE($2, title),
         summary = COALESCE($3, summary),
         confidence = COALESCE($4, confidence),
         risk = COALESCE($5, risk),
         input_tokens = COALESCE($6, input_tokens),
         output_tokens = COALESCE($7, output_tokens),
         failure_reason = $8,
         updated_at = now()
     WHERE id = $1`,
    [
      proposalId,
      details?.title ?? null,
      details?.summary ?? null,
      details?.confidence ?? null,
      details?.risk ?? null,
      details?.inputTokens ?? null,
      details?.outputTokens ?? null,
      reason.slice(0, 1_000),
    ],
  );
}

async function saveReadyProposal(
  pool: Pool,
  proposal: AutofixProposal,
  result: z.infer<typeof modelResultSchema>,
  scripts: Map<string, PlaceScript>,
  usage: { input: number; output: number },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE roblox_autofix_proposals
       SET status = 'ready', title = $2, summary = $3, confidence = $4,
           risk = $5, input_tokens = $6, output_tokens = $7,
           failure_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [
        proposal.id,
        result.title,
        result.summary,
        result.confidence,
        result.risk,
        usage.input,
        usage.output,
      ],
    );
    for (const change of result.changes) {
      const script = scripts.get(change.path)!;
      await client.query(
        `INSERT INTO roblox_autofix_files (
           proposal_id, script_path, script_class, base_source_sha256,
           base_source, proposed_source, patch
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          proposal.id,
          script.path,
          script.className,
          sha256(script.source),
          script.source,
          change.proposedSource,
          JSON.stringify(patchFor(script.path, script.source, change.proposedSource)),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processRun(
  options: AutofixWorkerOptions,
  run: AutofixRun,
): Promise<void> {
  const body = await options.storage.get(run.object_key);
  if (!body || createHash("sha256").update(body).digest("hex") !== run.sha256) {
    throw new Error("Place snapshot is missing or failed checksum verification");
  }
  const scripts = extractScriptsFromPlace(body);
  if (scripts.length === 0) throw new Error("Place snapshot contains no readable scripts");
  const proposals = await loadProposals(options.pool, run.id);
  let runInputTokens = Number(run.input_tokens);
  let runOutputTokens = Number(run.output_tokens);

  for (const proposal of proposals) {
    if (
      runInputTokens >= MAX_RUN_INPUT_TOKENS ||
      runOutputTokens >= MAX_RUN_OUTPUT_TOKENS
    ) {
      await markUnable(
        options.pool,
        proposal.id,
        "The batch reached Trace's strict token budget before this bug was processed.",
      );
      continue;
    }
    await options.pool.query(
      `UPDATE roblox_autofix_proposals
       SET status = 'processing', updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [proposal.id],
    );
    try {
      const target = findTargetScript(
        scripts,
        proposal.source_script,
        proposal.normalized_stack,
      );
      if (!target) {
        await markUnable(
          options.pool,
          proposal.id,
          "Trace could not identify one unambiguous source script for this error.",
        );
        continue;
      }
      const context = contextFor(scripts, target, proposal);
      if (context.length === 0) {
        await markUnable(
          options.pool,
          proposal.id,
          "The source script is too large for a bounded, reliable autofix review.",
        );
        continue;
      }
      const response = await requestFix(
        options,
        proposal,
        context,
        MAX_RUN_INPUT_TOKENS - runInputTokens,
        MAX_RUN_OUTPUT_TOKENS - runOutputTokens,
      );
      const inputTokens =
        response.usage.prompt_tokens ?? response.estimatedInputTokens;
      const outputTokens =
        response.usage.completion_tokens ??
        Math.ceil(JSON.stringify(response.result).length / 4);
      runInputTokens += inputTokens;
      runOutputTokens += outputTokens;
      await options.pool.query(
        `UPDATE roblox_autofix_runs
         SET input_tokens = $2, output_tokens = $3
         WHERE id = $1`,
        [run.id, runInputTokens, runOutputTokens],
      );

      const result = response.result;
      if (
        result.outcome !== "fixed" ||
        result.confidence < MIN_CONFIDENCE ||
        result.changes.length === 0
      ) {
        await markUnable(
          options.pool,
          proposal.id,
          result.reason ?? "The model could not establish a safe, focused fix.",
          {
            title: result.title,
            summary: result.summary,
            confidence: result.confidence,
            risk: result.risk,
            inputTokens,
            outputTokens,
          },
        );
        continue;
      }

      const byPath = new Map(context.map((script) => [script.path, script]));
      const uniquePaths = new Set(result.changes.map((change) => change.path));
      const invalid = result.changes.find((change) => {
        const script = byPath.get(change.path);
        return (
          !script ||
          change.proposedSource === script.source ||
          change.proposedSource.includes("```") ||
          change.proposedSource.includes("<<<<<<<") ||
          change.proposedSource.includes(">>>>>>>")
        );
      });
      if (invalid || uniquePaths.size !== result.changes.length) {
        await markUnable(
          options.pool,
          proposal.id,
          "The proposed change did not satisfy Trace's path and source safety checks.",
          {
            title: result.title,
            summary: result.summary,
            confidence: result.confidence,
            risk: result.risk,
            inputTokens,
            outputTokens,
          },
        );
        continue;
      }
      await saveReadyProposal(options.pool, proposal, result, byPath, {
        input: inputTokens,
        output: outputTokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === "autofix_input_budget_exhausted" ||
        message === "autofix_output_budget_exhausted"
      ) {
        await markUnable(
          options.pool,
          proposal.id,
          "The batch reached Trace's strict token budget before this fix could be requested.",
        );
        continue;
      }
      await options.pool.query(
        `UPDATE roblox_autofix_proposals
         SET status = 'failed', failure_reason = $2, updated_at = now()
         WHERE id = $1`,
        [proposal.id, message.slice(0, 1_000)],
      );
      options.logger?.warn(
        { error, proposalId: proposal.id, runId: run.id },
        "Roblox autofix proposal failed",
      );
    }
  }

  await options.pool.query(
    `UPDATE roblox_autofix_runs
     SET status = 'completed', finished_at = now(),
         input_tokens = $2, output_tokens = $3
     WHERE id = $1`,
    [run.id, runInputTokens, runOutputTokens],
  );
}

async function failRun(pool: Pool, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE roblox_autofix_runs
     SET status = 'failed', finished_at = now(), last_error = $2
     WHERE id = $1`,
    [runId, message.slice(0, 1_000)],
  );
  await pool.query(
    `UPDATE roblox_autofix_proposals
     SET status = 'failed', failure_reason = $2, updated_at = now()
     WHERE run_id = $1 AND status IN ('queued', 'processing')`,
    [runId, message.slice(0, 1_000)],
  );
}

async function queueProjectRun(
  options: AutofixSchedulerOptions,
  projectId: string,
  credentialId: string,
): Promise<number> {
  const client = await options.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`roblox-autofix:${projectId}`],
    );
    const active = await client.query(
      `SELECT id
       FROM roblox_autofix_runs
       WHERE project_id = $1 AND status IN ('queued', 'processing')
       LIMIT 1`,
      [projectId],
    );
    if (active.rows[0]) {
      await client.query("COMMIT");
      return 0;
    }

    const outstanding = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM roblox_autofix_proposals
       WHERE project_id = $1
         AND status IN ('queued', 'processing', 'ready', 'conflict')`,
      [projectId],
    );
    const remainingCapacity =
      MAX_AUTOFIX_PROPOSALS - Number(outstanding.rows[0]?.count ?? 0);
    if (remainingCapacity <= 0) {
      await client.query("COMMIT");
      return 0;
    }

    const snapshot = await client.query<{ id: string }>(
      `SELECT id
       FROM roblox_place_snapshots
       WHERE project_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [projectId],
    );
    const snapshotId = snapshot.rows[0]?.id;
    if (!snapshotId) {
      await client.query("COMMIT");
      return 0;
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
      [projectId, snapshotId, remainingCapacity],
    );
    if (candidates.rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const run = await client.query<{ id: string }>(
      `INSERT INTO roblox_autofix_runs (
         project_id, snapshot_id, requested_by_credential_id,
         max_proposals, model
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        projectId,
        snapshotId,
        credentialId,
        remainingCapacity,
        options.model,
      ],
    );
    for (const [index, candidate] of candidates.rows.entries()) {
      await client.query(
        `INSERT INTO roblox_autofix_proposals (
           run_id, project_id, snapshot_id, error_group_id,
           priority_rank, ai_category, model
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          run.rows[0]!.id,
          projectId,
          snapshotId,
          candidate.error_group_id,
          index + 1,
          candidate.ai_category,
          options.model,
        ],
      );
    }
    await client.query("COMMIT");
    return candidates.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queueScheduledAutofixRuns(
  options: AutofixSchedulerOptions,
): Promise<number> {
  const eligible = await options.pool.query<{
    credential_id: string;
    project_id: string;
  }>(
    `SELECT DISTINCT ON (credential.project_id)
            credential.project_id,
            credential.id AS credential_id
     FROM roblox_plugin_credentials credential
     WHERE credential.revoked_at IS NULL
       AND credential.expires_at > now()
       AND EXISTS (
         SELECT 1
         FROM roblox_place_snapshots snapshot
         WHERE snapshot.project_id = credential.project_id
       )
     ORDER BY
       credential.project_id,
       credential.last_used_at DESC NULLS LAST,
       credential.created_at DESC,
       credential.id`,
  );
  let queued = 0;
  for (const project of eligible.rows) {
    try {
      queued += await queueProjectRun(
        options,
        project.project_id,
        project.credential_id,
      );
    } catch (error) {
      options.logger?.error(
        { error, projectId: project.project_id },
        "Roblox autofix scheduler could not queue project",
      );
    }
  }
  if (queued > 0) {
    options.logger?.info(
      { proposals: queued, projects: eligible.rows.length },
      "Roblox autofix scheduler queued priority bugs",
    );
  }
  return queued;
}

export function startRobloxAutofixScheduler(
  options: AutofixSchedulerOptions,
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? AUTOFIX_SCHEDULE_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    active = queueScheduledAutofixRuns(options)
      .catch((error) => {
        options.logger?.error(error, "Roblox autofix scheduler failed");
        return;
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(schedule, intervalMs);
          timer.unref();
        }
      });
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}

export function startRobloxAutofixWorker(
  options: AutofixWorkerOptions,
): () => Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    const run = await claimRun(options.pool);
    if (run) {
      try {
        await processRun(options, run);
        options.logger?.info(
          { runId: run.id, projectId: run.project_id },
          "Roblox autofix run completed",
        );
      } catch (error) {
        await failRun(options.pool, run.id, error);
        options.logger?.error(
          { error, runId: run.id },
          "Roblox autofix run failed",
        );
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    active = poll()
      .catch((error) => {
        options.logger?.error(error, "Roblox autofix worker poll failed");
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(schedule, pollIntervalMs);
          timer.unref();
        }
      });
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}
