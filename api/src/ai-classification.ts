import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "./db.js";

export const ERROR_AI_CATEGORIES = [
  "critical",
  "high",
  "medium",
  "low",
  "not_a_bug",
] as const;
export const FEEDBACK_AI_CATEGORIES = [
  "bug_report",
  "critique",
  "suggestion",
  "general",
] as const;

export type ErrorAICategory = (typeof ERROR_AI_CATEGORIES)[number];
export type FeedbackAICategory = (typeof FEEDBACK_AI_CATEGORIES)[number];
type ClassificationTarget = "error" | "feedback";

type ClassificationJob = {
  target_type: ClassificationTarget;
  target_id: string;
  project_id: string;
  attempts: number;
};

type ClassificationInput = {
  id: string;
  type: ClassificationTarget;
  message: string;
  severity?: string;
  side?: string;
  source?: string | null;
};

type ClassificationResult = {
  id: string;
  category: ErrorAICategory | FeedbackAICategory;
  confidence: number;
  reason: string;
};

export type ClassificationWorkerOptions = {
  pool: Pool;
  apiKey: string;
  model: string;
  webOrigin: string;
  batchSize?: number;
  pollIntervalMs?: number;
  fetchImplementation?: typeof fetch;
  logger?: {
    info: (value: unknown, message?: string) => void;
    warn: (value: unknown, message?: string) => void;
    error: (value: unknown, message?: string) => void;
  };
};

const openRouterResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

const resultEnvelopeSchema = z.object({
  results: z.array(z.object({
    key: z.number().int().min(0),
    category: z.string(),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(120),
  })),
});

const promptVersion = 1;
const maxAttempts = 5;

function categoriesFor(target: ClassificationTarget): readonly string[] {
  return target === "error" ? ERROR_AI_CATEGORIES : FEEDBACK_AI_CATEGORIES;
}

function systemPrompt(target: ClassificationTarget): string {
  if (target === "error") {
    return `You classify normalized Roblox and Luau telemetry groups for a game developer dashboard.
Use Roblox/Luau domain knowledge: understand Roblox services and engine behavior (including DataStoreService, MarketplaceService, MemoryStoreService, MessagingService, animation tracks, RemoteEvents, HTTP requests, replication, streaming, and client/server boundaries), Luau stack/source conventions, and common Roblox platform throttling or transient warnings. Distinguish developer print/warn diagnostics from thrown faults. Do not call an engine warning critical merely because the incoming telemetry level says error or warning.
Choose exactly one priority:
- critical: likely outage, data loss, security issue, purchase failure at scale, or a core loop unusable for many players
- high: clear actionable bug with major player impact, but not a broad outage
- medium: actionable bug with limited impact or a meaningful performance/reliability issue
- low: minor defect, warning, edge case, or low-impact issue
- not_a_bug: intentional developer logging, expected platform behavior, benign lifecycle noise, or informational text
Judge the normalized group, not individual IDs. Treat the provided severity as evidence, not truth. Be conservative with critical. Return a reason of at most 12 words without exposing chain-of-thought.`;
  }
  return `You classify player-submitted Roblox game feedback for a developer dashboard.
Choose exactly one category:
- bug_report: the player describes broken, incorrect, missing, or malfunctioning behavior
- critique: the player expresses dissatisfaction or evaluates an existing design without proposing a clear new feature
- suggestion: the player proposes a feature, change, or improvement
- general: praise, greetings, random text, neutral remarks, or anything with no actionable product signal
When a message both reports breakage and suggests a fix, prefer bug_report. Return a reason of at most 12 words without exposing chain-of-thought.`;
}

function responseFormat(target: ClassificationTarget) {
  return {
    type: "json_schema",
    json_schema: {
      name: `${target}_classifications`,
      strict: true,
      schema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "integer", minimum: 0 },
                category: {
                  type: "string",
                  enum: [...categoriesFor(target)],
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reason: { type: "string", maxLength: 120 },
              },
              required: ["key", "category", "confidence", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["results"],
        additionalProperties: false,
      },
    },
  };
}

export async function classifyWithOpenRouter(
  options: Pick<
    ClassificationWorkerOptions,
    "apiKey" | "model" | "webOrigin" | "fetchImplementation"
  >,
  target: ClassificationTarget,
  inputs: ClassificationInput[],
  signal?: AbortSignal,
): Promise<ClassificationResult[]> {
  if (inputs.length === 0) return [];
  const fetcher = options.fetchImplementation ?? fetch;
  const response = await fetcher(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "HTTP-Referer": options.webOrigin,
        "X-Title": "Trace",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: systemPrompt(target) },
          {
            role: "user",
            content: JSON.stringify({
              items: inputs.map(({ message, severity, side, source }, key) => ({
                key,
                message,
                ...(target === "error" ? { severity, side, source } : {}),
              })),
            }),
          },
        ],
        response_format: responseFormat(target),
        reasoning: { effort: "minimal", exclude: true },
        temperature: 0,
        max_completion_tokens: Math.max(350, inputs.length * 90),
      }),
      signal,
    },
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`OpenRouter returned ${response.status}: ${body}`);
  }

  const completion = openRouterResponseSchema.parse(await response.json());
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("OpenRouter returned no classification content");
  const parsed = resultEnvelopeSchema.parse(JSON.parse(content));
  const allowed = new Set(categoriesFor(target));
  const seen = new Set<number>();
  const results = parsed.results.flatMap((result) => {
    if (
      result.key >= inputs.length ||
      seen.has(result.key) ||
      !allowed.has(result.category)
    ) {
      return [];
    }
    seen.add(result.key);
    const input = inputs[result.key];
    if (!input) return [];
    return [{
      id: input.id,
      category: result.category,
      confidence: result.confidence,
      reason: result.reason,
    }];
  }) as ClassificationResult[];
  if (results.length !== inputs.length) {
    throw new Error(
      `OpenRouter returned ${results.length} of ${inputs.length} classifications`,
    );
  }
  return results;
}

async function claimJobs(
  pool: Pool,
  workerId: string,
  limit: number,
): Promise<ClassificationJob[]> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ClassificationJob>(
      `WITH candidates AS (
         SELECT target_type, target_id
         FROM ai_classification_jobs
         WHERE (
             status = 'pending'
             AND available_at <= now()
           )
           OR (
             status = 'processing'
             AND locked_at < now() - interval '2 minutes'
           )
         ORDER BY priority DESC, available_at, created_at, target_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE ai_classification_jobs jobs
       SET status = 'processing',
           attempts = jobs.attempts + 1,
           locked_at = now(),
           locked_by = $2
       FROM candidates
       WHERE jobs.target_type = candidates.target_type
         AND jobs.target_id = candidates.target_id
       RETURNING
         jobs.target_type,
         jobs.target_id,
         jobs.project_id,
         jobs.attempts`,
      [limit, workerId],
    );
    return result.rows;
  });
}

async function loadInputs(
  pool: Pool,
  target: ClassificationTarget,
  ids: string[],
): Promise<ClassificationInput[]> {
  if (ids.length === 0) return [];
  if (target === "error") {
    const result = await pool.query(
      `SELECT
         id,
         normalized_message AS message,
         level::text AS severity,
         source::text AS side,
         source_script AS source
       FROM display_error_groups
       WHERE id = ANY($1::uuid[])
         AND ai_status <> 'classified'`,
      [ids],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      type: target,
      message: String(row.message),
      severity: String(row.severity),
      side: String(row.side),
      source: row.source === null ? null : String(row.source),
    }));
  }
  const result = await pool.query(
    `SELECT id, message
     FROM feedback
     WHERE id = ANY($1::uuid[])
       AND ai_status <> 'classified'`,
    [ids],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    type: target,
    message: String(row.message),
  }));
}

async function applyResults(
  client: PoolClient,
  target: ClassificationTarget,
  results: ClassificationResult[],
  workerId: string,
  model: string,
): Promise<void> {
  if (results.length === 0) return;
  const ids = results.map((result) => result.id);
  const categories = results.map((result) => result.category);
  const confidences = results.map((result) => result.confidence);
  const reasons = results.map((result) => result.reason);

  if (target === "error") {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM unnest(
           $1::uuid[],
           $2::error_ai_category[],
           $3::real[],
           $4::text[]
         ) AS input(id, category, confidence, reason)
       )
       UPDATE display_error_groups groups
       SET ai_category = input.category,
           ai_confidence = input.confidence,
           ai_reason = input.reason,
           ai_classified_at = now(),
           ai_model = $5,
           ai_prompt_version = $6,
           ai_status = 'classified'
       FROM input
       WHERE groups.id = input.id`,
      [ids, categories, confidences, reasons, model, promptVersion],
    );
    await client.query(
      `WITH input AS (
         SELECT *
         FROM unnest(
           $1::uuid[],
           $2::error_ai_category[]
         ) AS input(id, category)
       )
       UPDATE display_error_rollups_hourly rollups
       SET ai_category = input.category
       FROM input
       WHERE rollups.display_group_id = input.id
         AND rollups.ai_category IS DISTINCT FROM input.category`,
      [ids, categories],
    );
  } else {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM unnest(
           $1::uuid[],
           $2::feedback_ai_category[],
           $3::real[],
           $4::text[]
         ) AS input(id, category, confidence, reason)
       )
       UPDATE feedback
       SET ai_category = input.category,
           ai_confidence = input.confidence,
           ai_reason = input.reason,
           ai_classified_at = now(),
           ai_model = $5,
           ai_prompt_version = $6,
           ai_status = 'classified'
       FROM input
       WHERE feedback.id = input.id`,
      [ids, categories, confidences, reasons, model, promptVersion],
    );
  }
  await client.query(
    `DELETE FROM ai_classification_jobs jobs
     USING unnest($2::uuid[]) AS input(id)
     WHERE jobs.target_type = $1::ai_classification_target
       AND jobs.target_id = input.id
       AND jobs.locked_by = $3`,
    [target, ids, workerId],
  );
}

async function discardMissingTargets(
  pool: Pool,
  jobs: ClassificationJob[],
  loadedIds: Set<string>,
  workerId: string,
): Promise<void> {
  const missing = jobs.filter((job) => !loadedIds.has(job.target_id));
  if (missing.length === 0) return;
  await pool.query(
    `DELETE FROM ai_classification_jobs
     WHERE locked_by = $1
       AND (target_type, target_id) IN (
         SELECT *
         FROM unnest($2::ai_classification_target[], $3::uuid[])
       )`,
    [
      workerId,
      missing.map((job) => job.target_type),
      missing.map((job) => job.target_id),
    ],
  );
}

async function releaseFailedJobs(
  pool: Pool,
  jobs: ClassificationJob[],
  workerId: string,
  error: unknown,
): Promise<void> {
  if (jobs.length === 0) return;
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 500);
  await withTransaction(pool, async (client) => {
    const failed = jobs.filter((job) => job.attempts >= maxAttempts);
    const retrying = jobs.filter((job) => job.attempts < maxAttempts);
    if (retrying.length > 0) {
      await client.query(
        `UPDATE ai_classification_jobs
         SET status = 'pending',
             available_at = now() + make_interval(
               secs => LEAST(300, power(2, attempts)::integer * 5)
             ),
             locked_at = NULL,
             locked_by = NULL,
             last_error = $4
         WHERE locked_by = $1
           AND (target_type, target_id) IN (
             SELECT *
             FROM unnest($2::ai_classification_target[], $3::uuid[])
           )`,
        [
          workerId,
          retrying.map((job) => job.target_type),
          retrying.map((job) => job.target_id),
          message,
        ],
      );
    }
    for (const job of failed) {
      const table =
        job.target_type === "error" ? "display_error_groups" : "feedback";
      await client.query(
        `UPDATE ${table}
         SET ai_status = 'failed'
         WHERE id = $1 AND ai_status <> 'classified'`,
        [job.target_id],
      );
      await client.query(
        `DELETE FROM ai_classification_jobs
         WHERE target_type = $1::ai_classification_target
           AND target_id = $2
           AND locked_by = $3`,
        [job.target_type, job.target_id, workerId],
      );
    }
  });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export function startAIClassificationWorker(
  options: ClassificationWorkerOptions,
): () => Promise<void> {
  const controller = new AbortController();
  const workerId = randomUUID();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 12, 50));
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_500);
  const logger = options.logger ?? console;

  const running = (async () => {
    while (!controller.signal.aborted) {
      let jobs: ClassificationJob[] = [];
      try {
        jobs = await claimJobs(options.pool, workerId, batchSize);
        if (jobs.length === 0) {
          await wait(pollIntervalMs, controller.signal);
          continue;
        }

        for (const target of ["error", "feedback"] as const) {
          const targetJobs = jobs.filter((job) => job.target_type === target);
          if (targetJobs.length === 0) continue;
          try {
            const inputs = await loadInputs(
              options.pool,
              target,
              targetJobs.map((job) => job.target_id),
            );
            const loadedIds = new Set(inputs.map((input) => input.id));
            await discardMissingTargets(
              options.pool,
              targetJobs,
              loadedIds,
              workerId,
            );
            if (inputs.length === 0) continue;
            const timeout = AbortSignal.timeout(20_000);
            const signal = AbortSignal.any([controller.signal, timeout]);
            const results = await classifyWithOpenRouter(
              options,
              target,
              inputs,
              signal,
            );
            await withTransaction(options.pool, (client) =>
              applyResults(client, target, results, workerId, options.model)
            );
            logger.info(
              { target, count: results.length, model: options.model },
              "AI classifications applied",
            );
          } catch (error) {
            await releaseFailedJobs(
              options.pool,
              targetJobs,
              workerId,
              error,
            );
            if (!controller.signal.aborted) {
              logger.warn(
                { err: error, target, count: targetJobs.length },
                "AI classification batch failed",
              );
            }
          }
        }
      } catch (error) {
        if (jobs.length > 0) {
          await releaseFailedJobs(options.pool, jobs, workerId, error).catch(
            () => undefined,
          );
        }
        if (!controller.signal.aborted) {
          logger.error(error, "AI classification worker failed");
          await wait(pollIntervalMs, controller.signal);
        }
      }
    }
  })();

  return async () => {
    controller.abort();
    await running;
  };
}
