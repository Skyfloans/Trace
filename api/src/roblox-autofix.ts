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
export const AUTOFIX_PROCESSING_LEASE_MS = 2 * 60 * 1_000;
const AUTOFIX_RECOVERY_INTERVAL_MS = 60 * 1_000;
const MAX_CHANGED_SCRIPTS = 5;
const MAX_EDITS_PER_SCRIPT = 8;
const MAX_CONTEXT_REQUESTS = 6;
const MAX_CONTEXT_EXPANSION_ROUNDS = 1;
const MAX_INITIAL_CONTEXT_SCRIPTS = 4;
const MAX_CONTEXT_SCRIPTS = 10;
const MAX_SCRIPT_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 80_000;
const MAX_MANIFEST_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 6_000;
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

export type AutofixProposal = {
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
  outcome: z.enum(["fixed", "unable", "need_context"]),
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(400),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  reason: z.string().trim().min(1).max(300),
  contextRequests: z.array(
    z.string().trim().min(1).max(1_000),
  ).max(MAX_CONTEXT_REQUESTS),
  changes: z.array(z.object({
    path: z.string().trim().min(1).max(1_000),
    edits: z.array(z.object({
      oldText: z.string().min(1).max(MAX_SCRIPT_CHARS),
      newText: z.string().max(MAX_SCRIPT_CHARS),
    })).min(1).max(MAX_EDITS_PER_SCRIPT),
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

function studioPath(value: string): string {
  const segments = pathSegments(value);
  if (segments[0] === "game") segments.shift();
  if (segments[0] !== "players" || segments.length < 4) {
    return segments.join(".");
  }
  const container = segments[2];
  const rest = segments.slice(3);
  if (container === "playerscripts") {
    return ["starterplayer", "starterplayerscripts", ...rest].join(".");
  }
  if (container === "playergui") {
    return ["startergui", ...rest].join(".");
  }
  if (container === "backpack") {
    return ["starterpack", ...rest].join(".");
  }
  if (container === "character") {
    return ["starterplayer", "startercharacterscripts", ...rest].join(".");
  }
  return segments.join(".");
}

function suffixMatches(path: string, source: string): boolean {
  const left = studioPath(path).split(".").filter(Boolean);
  const right = studioPath(source).split(".").filter(Boolean);
  if (right.length === 0 || right.length > left.length) return false;
  return right.every(
    (segment, index) => segment === left[left.length - right.length + index],
  );
}

const SCRIPT_EVIDENCE_STOP_WORDS = new Set([
  "attempt",
  "error",
  "failed",
  "failure",
  "function",
  "index",
  "internal",
  "invalid",
  "local",
  "server",
  "service",
  "traceback",
  "unknown",
]);

function evidenceIdentifiers(value: string): string[] {
  const identifiers = value.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? [];
  return [...new Set(
    identifiers
      .map((identifier) => identifier.toLowerCase())
      .filter((identifier) => !SCRIPT_EVIDENCE_STOP_WORDS.has(identifier)),
  )].slice(0, 40);
}

function leadingTag(value: string): string | null {
  const tag = value.match(/^\s*\[([^\]\r\n]{2,80})\]/)?.[1]?.trim();
  return tag ? tag.toLowerCase() : null;
}

function discoveryScore(
  script: PlaceScript,
  evidence: string,
  identifiers: string[],
  tag: string | null,
): { identifierMatches: number; score: number } {
  const path = script.path.toLowerCase();
  const name = script.name.toLowerCase();
  const source = script.source.toLowerCase();
  let score = evidence.includes(path) ? 100 : 0;
  if (name.length >= 3 && evidence.includes(name)) score += 20;
  if (tag) {
    if (name === tag || path.split(".").includes(tag)) score += 60;
    if (
      source.includes(`["${tag}"]`) ||
      source.includes(`['${tag}']`) ||
      source.includes(`"[${tag}]`) ||
      source.includes(`'[${tag}]`)
    ) {
      score += 45;
    } else if (source.includes(`[${tag}]`)) {
      score += 25;
    }
  }
  const identifierMatches = identifiers.filter((identifier) =>
    source.includes(identifier)
  ).length;
  score += Math.min(identifierMatches, 8);
  return { identifierMatches, score };
}

export function findTargetScript(
  scripts: PlaceScript[],
  sourceScript: string | null,
  stack: string | null,
  message: string | null = null,
): PlaceScript | null {
  if (sourceScript) {
    const exact = scripts.filter(
      (script) => studioPath(script.path) === studioPath(sourceScript),
    );
    if (exact.length === 1) return exact[0]!;
    const suffix = scripts.filter((script) =>
      suffixMatches(script.path, sourceScript)
    );
    if (suffix.length === 1) return suffix[0]!;
  }

  const evidence = [
    sourceScript ?? "",
    stack ?? "",
    message ?? "",
  ].join("\n").toLowerCase();
  const identifiers = evidenceIdentifiers(evidence);
  const tag = leadingTag(message ?? "");
  const scored = scripts
    .map((script) => {
      const scored = discoveryScore(script, evidence, identifiers, tag);
      return { ...scored, script };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored[0] || scored[1]?.score === scored[0].score) return null;
  if (
    scored[0].score < 20 &&
    (
      scored[0].identifierMatches < 2 ||
      scored[0].score - (scored[1]?.score ?? 0) < 2
    )
  ) {
    return null;
  }
  return scored[0].script;
}

export function findDiscoveryScripts(
  scripts: PlaceScript[],
  sourceScript: string | null,
  stack: string | null,
  message: string,
): PlaceScript[] {
  const evidence = [
    sourceScript ?? "",
    stack ?? "",
    message,
  ].join("\n").toLowerCase();
  const identifiers = evidenceIdentifiers(evidence);
  const tag = leadingTag(message);
  const candidates = scripts
    .filter((script) => script.source.length <= MAX_SCRIPT_CHARS)
    .map((script) => ({
      script,
      ...discoveryScore(script, evidence, identifiers, tag),
    }))
    .filter(({ score, identifierMatches }) =>
      score >= 20 || identifierMatches >= 2
    )
    .sort((left, right) =>
      right.score - left.score || left.script.path.localeCompare(right.script.path)
    );
  const selected: PlaceScript[] = [];
  let characters = 0;
  for (const { script } of candidates) {
    if (selected.length >= MAX_CONTEXT_SCRIPTS) break;
    if (characters + script.source.length > MAX_CONTEXT_CHARS) continue;
    selected.push(script);
    characters += script.source.length;
  }
  return selected;
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
  const relatedIdentifiers = evidenceIdentifiers(
    `${proposal.normalized_message}\n${proposal.normalized_stack ?? ""}`,
  );
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
      if (
        script.source.toLowerCase().includes(target.name.toLowerCase()) ||
        script.source.toLowerCase().includes(target.path.toLowerCase())
      ) {
        score += 8;
      }
      score += Math.min(
        relatedIdentifiers.filter((identifier) =>
          script.source.toLowerCase().includes(identifier)
        ).length,
        4,
      );
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

function scriptManifest(
  scripts: PlaceScript[],
  proposal: AutofixProposal,
): string[] {
  const manifest: string[] = [];
  let characters = 0;
  const evidence = [
    proposal.source_script ?? "",
    proposal.normalized_stack ?? "",
    proposal.normalized_message,
  ].join("\n").toLowerCase();
  const identifiers = evidenceIdentifiers(evidence);
  const tag = leadingTag(proposal.normalized_message);
  const ranked = scripts
    .map((script) => ({
      script,
      score: discoveryScore(script, evidence, identifiers, tag).score,
    }))
    .sort((left, right) =>
      right.score - left.score ||
      left.script.path.localeCompare(right.script.path)
    );
  for (const { script } of ranked) {
    const entry = `${script.className} ${script.path}`;
    if (characters + entry.length > MAX_MANIFEST_CHARS) break;
    manifest.push(entry);
    characters += entry.length;
  }
  return manifest;
}

export function expandRequestedContext(
  scripts: PlaceScript[],
  current: PlaceScript[],
  requests: string[],
): PlaceScript[] {
  const selected = new Map(current.map((script) => [script.path, script]));
  let characters = current.reduce(
    (total, script) => total + script.source.length,
    0,
  );
  for (const request of requests) {
    if (
      selected.size >= MAX_CONTEXT_SCRIPTS ||
      characters >= MAX_CONTEXT_CHARS
    ) {
      break;
    }
    const evidence = request.toLowerCase();
    const identifiers = evidenceIdentifiers(evidence);
    const candidates = scripts
      .filter((script) => !selected.has(script.path))
      .filter((script) => script.source.length <= MAX_SCRIPT_CHARS)
      .map((script) => {
        const path = script.path.toLowerCase();
        const normalizedRequest = normalizePath(request);
        const normalizedScript = normalizePath(script.path);
        let score = 0;
        if (
          normalizedRequest === normalizedScript ||
          evidence.includes(path)
        ) {
          score += 100;
        } else if (
          suffixMatches(script.path, request) ||
          normalizedRequest.endsWith(`.${script.name.toLowerCase()}`)
        ) {
          score += 60;
        } else if (
          evidence.includes(script.name.toLowerCase()) &&
          script.name.length >= 3
        ) {
          score += 25;
        }
        score += Math.min(
          identifiers.filter((identifier) =>
            script.source.toLowerCase().includes(identifier)
          ).length,
          8,
        );
        return { script, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        left.script.path.localeCompare(right.script.path)
      );
    const bestScore = candidates[0]?.score ?? 0;
    for (const { script, score } of candidates) {
      if (selected.size >= MAX_CONTEXT_SCRIPTS) break;
      if (score < bestScore || bestScore < 20) break;
      if (characters + script.source.length > MAX_CONTEXT_CHARS) continue;
      selected.set(script.path, script);
      characters += script.source.length;
    }
  }
  return [...selected.values()];
}

export function applyExactEdits(
  source: string,
  edits: { oldText: string; newText: string }[],
): string | null {
  let proposed = source;
  for (const edit of edits) {
    if (edit.oldText === edit.newText) return null;
    const first = proposed.indexOf(edit.oldText);
    if (first < 0) return null;
    if (proposed.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
      return null;
    }
    proposed =
      proposed.slice(0, first) +
      edit.newText +
      proposed.slice(first + edit.oldText.length);
  }
  return proposed === source ? null : proposed;
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
          outcome: {
            type: "string",
            enum: ["fixed", "unable", "need_context"],
          },
          title: { type: "string", minLength: 1, maxLength: 80 },
          summary: { type: "string", minLength: 1, maxLength: 400 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          reason: { type: "string", minLength: 1, maxLength: 300 },
          contextRequests: {
            type: "array",
            maxItems: MAX_CONTEXT_REQUESTS,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 1_000,
            },
          },
          changes: {
            type: "array",
            maxItems: MAX_CHANGED_SCRIPTS,
            items: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 1_000 },
                edits: {
                  type: "array",
                  minItems: 1,
                  maxItems: MAX_EDITS_PER_SCRIPT,
                  items: {
                    type: "object",
                    properties: {
                      oldText: {
                        type: "string",
                        minLength: 1,
                        maxLength: MAX_SCRIPT_CHARS,
                      },
                      newText: {
                        type: "string",
                        maxLength: MAX_SCRIPT_CHARS,
                      },
                    },
                    required: ["oldText", "newText"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["path", "edits"],
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
          "contextRequests",
          "changes",
        ],
        additionalProperties: false,
      },
    },
  };
}

export async function requestFix(
  options: AutofixWorkerOptions,
  proposal: AutofixProposal,
  initialContext: PlaceScript[],
  allScripts: PlaceScript[],
  remainingInputTokens: number,
  remainingOutputTokens: number,
): Promise<{
  result: z.infer<typeof modelResultSchema>;
  context: PlaceScript[];
  usage: OpenRouterUsage;
  estimatedInputTokens: number;
}> {
  let context = initialContext.slice(0, MAX_INITIAL_CONTEXT_SCRIPTS);
  const manifest = scriptManifest(allScripts, proposal);
  const fetcher = options.fetchImplementation ?? fetch;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedInputTokens = 0;
  let previousContextRequests: string[] = [];

  for (
    let round = 0;
    round <= MAX_CONTEXT_EXPANSION_ROUNDS;
    round += 1
  ) {
    const userContent = JSON.stringify({
      bug: {
        category: proposal.ai_category,
        severity: proposal.level,
        side: proposal.source,
        message: proposal.normalized_message,
        sourceScript: proposal.source_script,
        stackTrace: proposal.normalized_stack,
      },
      investigation: {
        round: round + 1,
        maxRounds: MAX_CONTEXT_EXPANSION_ROUNDS + 1,
        canRequestMoreContext: round < MAX_CONTEXT_EXPANSION_ROUNDS,
        previousContextRequests,
        scriptManifest: manifest,
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
    let result: z.infer<typeof modelResultSchema> | null = null;

    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      if (
        estimatedInputTokens >
        remainingInputTokens - totalInputTokens
      ) {
        throw new Error("autofix_input_budget_exhausted");
      }
      if (remainingOutputTokens - totalOutputTokens < 500) {
        throw new Error("autofix_output_budget_exhausted");
      }
      await options.pool.query(
        `UPDATE roblox_autofix_proposals
         SET updated_at = now()
         WHERE id = $1 AND status = 'processing'`,
        [proposal.id],
      );
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
              {
                role: "user",
                content: attempt === 0
                  ? userContent
                  : `${userContent}\nThe previous response was malformed. Return only one complete object matching the JSON schema.`,
              },
            ],
            response_format: responseFormat(),
            provider: { require_parameters: true },
            plugins: [{ id: "response-healing" }],
            reasoning: { effort: "medium", exclude: true },
            temperature: 0,
            max_completion_tokens: Math.min(
              MAX_OUTPUT_TOKENS,
              remainingOutputTokens - totalOutputTokens,
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
      const inputTokens =
        completion.usage?.prompt_tokens ?? estimatedInputTokens;
      const outputTokens =
        completion.usage?.completion_tokens ??
        Math.ceil((content?.length ?? 0) / 4);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalEstimatedInputTokens += estimatedInputTokens;
      if (!content) {
        if (attempt === 1) {
          throw new Error(
            "OpenRouter returned no structured autofix content after one retry",
          );
        }
        continue;
      }
      try {
        result = modelResultSchema.parse(parseStructuredContent(content));
      } catch (error) {
        if (attempt === 1) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `OpenRouter returned invalid structured autofix output after one retry: ${message}`,
          );
        }
      }
    }

    if (!result) {
      throw new Error("OpenRouter returned no valid structured autofix output");
    }
    if (result.outcome !== "need_context") {
      return {
        result,
        context,
        usage: {
          prompt_tokens: totalInputTokens,
          completion_tokens: totalOutputTokens,
        },
        estimatedInputTokens: totalEstimatedInputTokens,
      };
    }
    if (
      round >= MAX_CONTEXT_EXPANSION_ROUNDS ||
      result.contextRequests.length === 0
    ) {
      return {
        result: {
          ...result,
          outcome: "unable",
          confidence: 0,
          changes: [],
          contextRequests: [],
          reason:
            "The bounded investigation ended before enough source evidence was available.",
        },
        context,
        usage: {
          prompt_tokens: totalInputTokens,
          completion_tokens: totalOutputTokens,
        },
        estimatedInputTokens: totalEstimatedInputTokens,
      };
    }
    const expanded = expandRequestedContext(
      allScripts,
      context,
      result.contextRequests,
    );
    if (expanded.length === context.length) {
      return {
        result: {
          ...result,
          outcome: "unable",
          confidence: 0,
          changes: [],
          contextRequests: [],
          reason:
            "Trace could not resolve the requested related scripts from the place manifest.",
        },
        context,
        usage: {
          prompt_tokens: totalInputTokens,
          completion_tokens: totalOutputTokens,
        },
        estimatedInputTokens: totalEstimatedInputTokens,
      };
    }
    previousContextRequests = result.contextRequests;
    context = expanded;
  }

  throw new Error("Autofix investigation exceeded its bounded rounds");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeCallCount(source: string, names: string[]): number {
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\s*\\(`, "gi");
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .reduce((count, line) => count + (line.match(pattern)?.length ?? 0), 0);
}

export function validateRootCauseChanges(
  changes: { baseSource: string; proposedSource: string }[],
): string | null {
  const baseFailures = changes.reduce(
    (total, change) =>
      total + runtimeCallCount(change.baseSource, ["error", "assert"]),
    0,
  );
  const proposedFailures = changes.reduce(
    (total, change) =>
      total + runtimeCallCount(change.proposedSource, ["error", "assert"]),
    0,
  );
  if (proposedFailures < baseFailures) {
    return "Trace rejected this change because it removed an existing error/assert signal instead of proving a root-cause fix.";
  }
  const baseWarnings = changes.reduce(
    (total, change) =>
      total + runtimeCallCount(change.baseSource, ["warn"]),
    0,
  );
  const proposedWarnings = changes.reduce(
    (total, change) =>
      total + runtimeCallCount(change.proposedSource, ["warn"]),
    0,
  );
  if (
    proposedWarnings < baseWarnings &&
    proposedFailures <= baseFailures
  ) {
    return "Trace rejected this change because it reduced failure reporting instead of correcting the failing behavior.";
  }
  const commentedDiagnostics = (source: string) =>
    source
      .split(/\r?\n/)
      .filter((line) =>
        /^\s*--.*\b(?:error|assert|warn)\s*\(/i.test(line)
      ).length;
  const baseCommentedDiagnostics = changes.reduce(
    (total, change) => total + commentedDiagnostics(change.baseSource),
    0,
  );
  const proposedCommentedDiagnostics = changes.reduce(
    (total, change) => total + commentedDiagnostics(change.proposedSource),
    0,
  );
  if (proposedCommentedDiagnostics > baseCommentedDiagnostics) {
    return "Trace rejected this change because it commented out an existing failure signal.";
  }
  return null;
}

export function validateRootCauseChange(
  baseSource: string,
  proposedSource: string,
): string | null {
  return validateRootCauseChanges([{ baseSource, proposedSource }]);
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

export async function recoverStaleAutofixWork(
  pool: Pool,
  leaseMs = AUTOFIX_PROCESSING_LEASE_MS,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stale = await client.query<{ run_id: string }>(
      `UPDATE roblox_autofix_proposals proposal
       SET status = 'queued', failure_reason = NULL, updated_at = now()
       FROM roblox_autofix_runs run
       WHERE proposal.run_id = run.id
         AND run.status = 'processing'
         AND proposal.status = 'processing'
         AND proposal.updated_at <
             now() - ($1::double precision * INTERVAL '1 millisecond')
       RETURNING proposal.run_id`,
      [leaseMs],
    );
    const runIds = [...new Set(stale.rows.map((row) => row.run_id))];
    if (runIds.length > 0) {
      await client.query(
        `UPDATE roblox_autofix_runs
         SET status = 'queued', started_at = NULL, finished_at = NULL,
             last_error = NULL
         WHERE id = ANY($1::uuid[])
           AND status = 'processing'`,
        [runIds],
      );
    }
    await client.query("COMMIT");
    return stale.rowCount ?? stale.rows.length;
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
  proposedSources: Map<string, string>,
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
        `Root cause: ${result.reason}\n\n${result.summary}`,
        result.confidence,
        result.risk,
        usage.input,
        usage.output,
      ],
    );
    for (const change of result.changes) {
      const script = scripts.get(change.path)!;
      const proposedSource = proposedSources.get(change.path)!;
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
          proposedSource,
          JSON.stringify(patchFor(script.path, script.source, proposedSource)),
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
        proposal.normalized_message,
      );
      const context = target
        ? contextFor(scripts, target, proposal)
        : findDiscoveryScripts(
          scripts,
          proposal.source_script,
          proposal.normalized_stack,
          proposal.normalized_message,
        );
      const response = await requestFix(
        options,
        proposal,
        context,
        scripts,
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

      const byPath = new Map(
        response.context.map((script) => [script.path, script]),
      );
      const uniquePaths = new Set(result.changes.map((change) => change.path));
      const proposedSources = new Map<string, string>();
      const invalid = result.changes.find((change) => {
        const script = byPath.get(change.path);
        const proposedSource = script
          ? applyExactEdits(script.source, change.edits)
          : null;
        if (proposedSource) {
          proposedSources.set(change.path, proposedSource);
        }
        return (
          !script ||
          !proposedSource ||
          proposedSource.includes("```") ||
          proposedSource.includes("<<<<<<<") ||
          proposedSource.includes(">>>>>>>")
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
      const safetyChanges = result.changes
        .map((change) => {
          const script = byPath.get(change.path);
          const proposedSource = proposedSources.get(change.path);
          return script && proposedSource
            ? { baseSource: script.source, proposedSource }
            : null;
        })
        .filter((change): change is {
          baseSource: string;
          proposedSource: string;
        } => change !== null);
      const unsafeReason = validateRootCauseChanges(safetyChanges);
      if (unsafeReason) {
        await markUnable(
          options.pool,
          proposal.id,
          unsafeReason,
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
      await saveReadyProposal(
        options.pool,
        proposal,
        result,
        byPath,
        proposedSources,
        {
          input: inputTokens,
          output: outputTokens,
        },
      );
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
  let nextRecoveryAt = 0;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() >= nextRecoveryAt) {
      const recovered = await recoverStaleAutofixWork(options.pool);
      nextRecoveryAt = Date.now() + AUTOFIX_RECOVERY_INTERVAL_MS;
      if (recovered > 0) {
        options.logger?.warn(
          { proposals: recovered },
          "Roblox autofix worker recovered stale processing work",
        );
      }
    }
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
