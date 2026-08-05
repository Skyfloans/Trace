import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { buildApp } from "../src/app.js";

const projectId = "20000000-0000-4000-8000-000000000001";
const credentialId = "30000000-0000-4000-8000-000000000001";
const snapshotId = "40000000-0000-4000-8000-000000000001";
const runId = "50000000-0000-4000-8000-000000000001";

function pluginSession() {
  return {
    credential_id: credentialId,
    project_id: projectId,
    project_name: "Unbox ASMR!",
    project_icon_url: null,
    source_universe_id: "10454554751",
    target_universe_id: "10587551620",
    studio_place_id: "72980619319007",
    expires_at: new Date(Date.now() + 60_000),
  };
}

test("plugin autofix inbox returns at most the current 15 requests", async () => {
  const proposals = Array.from({ length: 20 }, (_, index) => ({
    id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    run_id: runId,
    status: "queued",
    priority_rank: index + 1,
    ai_category: "high",
    title: null,
    summary: null,
    confidence: null,
    risk: null,
    failure_reason: null,
    created_at: "2026-07-28T21:00:00.000Z",
    updated_at: "2026-07-28T21:00:00.000Z",
    normalized_message: `Queued error ${index + 1}`,
    source_script: null,
    level: "error",
    source: "server",
    event_count: 1,
    file_count: 0,
  }));
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
        return { rows: [pluginSession()], rowCount: 1 };
      }
      if (sql.includes("FROM roblox_autofix_runs")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM roblox_autofix_proposals proposal")) {
        assert.match(sql, /LIMIT \$2/);
        assert.deepEqual(values, [projectId, 15]);
        return { rows: proposals, rowCount: proposals.length };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4-nano" },
  );

  const response = await app.inject({
    method: "GET",
    url: "/v1/plugin-autofix/proposals",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().proposals.length, 15);
  assert.equal(response.json().proposals[14].priorityRank, 15);
  await app.close();
});

test("plugin autofix queues at most 15 classified bugs in critical-first order", async () => {
  let candidateSql = "";
  let candidateLimit: unknown;
  const insertedCategories: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
      return { rows: [pluginSession()], rowCount: 1 };
    }
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.includes("pg_advisory_xact_lock")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM roblox_autofix_runs") &&
      sql.includes("status IN ('queued', 'processing')")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("COUNT(*)::int AS count") &&
      sql.includes("FROM roblox_autofix_proposals")
    ) {
      return { rows: [{ count: 0 }], rowCount: 1 };
    }
    if (sql.includes("FROM roblox_place_snapshots")) {
      return { rows: [{ id: snapshotId }], rowCount: 1 };
    }
    if (sql.includes("WITH impact AS")) {
      candidateSql = sql;
      candidateLimit = values[2];
      return {
        rows: [
          {
            error_group_id: "60000000-0000-4000-8000-000000000001",
            ai_category: "critical",
          },
          {
            error_group_id: "60000000-0000-4000-8000-000000000002",
            ai_category: "high",
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("INSERT INTO roblox_autofix_runs")) {
      return {
        rows: [{ id: runId, created_at: "2026-07-28T21:00:00.000Z" }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO roblox_autofix_proposals")) {
      insertedCategories.push(String(values[5]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4" },
  );

  const response = await app.inject({
    method: "POST",
    url: "/v1/plugin-autofix/runs",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
    payload: { limit: 15 },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().run.proposalCount, 2);
  assert.equal(candidateLimit, 15);
  assert.match(candidateSql, /WHEN 'critical' THEN 0/);
  assert.match(candidateSql, /WHEN 'high' THEN 1/);
  assert.match(candidateSql, /COALESCE\(impact\.event_count, 0\) DESC/);
  assert.match(
    candidateSql,
    /PARTITION BY COALESCE\(error\.ai_family_key, error\.fingerprint\)/,
  );
  assert.match(candidateSql, /existing\.status = 'accepted'/);
  assert.match(candidateSql, /INTERVAL '7 days'/);
  assert.deepEqual(insertedCategories, ["critical", "high"]);
  await app.close();
});

test("plugin autofix does not queue work when OpenRouter or storage is absent", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
        return { rows: [pluginSession()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "https://tracestack.gg", null, pool);

  const response = await app.inject({
    method: "POST",
    url: "/v1/plugin-autofix/runs",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
    payload: { limit: 15 },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "autofix_not_configured");
  await app.close();
});

test("ready and failed proposals can be regenerated in their existing queue slots", async () => {
  let proposalReset = false;
  let runReset = false;
  let currentStatus = "ready";
  let outstandingCount = 15;
  const query = async (sql: string) => {
    if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
      return { rows: [pluginSession()], rowCount: 1 };
    }
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.includes("pg_advisory_xact_lock")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("SELECT run_id, status") &&
      sql.includes("FROM roblox_autofix_proposals")
    ) {
      return {
        rows: [{ run_id: runId, status: currentStatus }],
        rowCount: 1,
      };
    }
    if (
      sql.includes("FROM roblox_autofix_runs") &&
      sql.includes("status IN ('queued', 'processing')")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("COUNT(*)::int AS count") &&
      sql.includes("FROM roblox_autofix_proposals")
    ) {
      assert.match(sql, /'queued', 'processing', 'ready', 'conflict'/);
      return { rows: [{ count: outstandingCount }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM roblox_autofix_files")) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("UPDATE roblox_autofix_proposals") &&
      sql.includes("SET status = 'queued'")
    ) {
      proposalReset = true;
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE roblox_autofix_runs") &&
      sql.includes("SET status = 'queued'")
    ) {
      assert.match(sql, /input_tokens = 0/);
      assert.match(sql, /output_tokens = 0/);
      runReset = true;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4-nano" },
  );

  const response = await app.inject({
    method: "POST",
    url:
      "/v1/plugin-autofix/proposals/60000000-0000-4000-8000-000000000001/review",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
    payload: { action: "retry" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "queued");
  assert.equal(proposalReset, true);
  assert.equal(runReset, true);

  currentStatus = "failed";
  outstandingCount = 14;
  proposalReset = false;
  runReset = false;
  const failedResponse = await app.inject({
    method: "POST",
    url:
      "/v1/plugin-autofix/proposals/60000000-0000-4000-8000-000000000001/review",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
    payload: { action: "retry" },
  });

  assert.equal(failedResponse.statusCode, 200);
  assert.equal(failedResponse.json().status, "queued");
  assert.equal(proposalReset, true);
  assert.equal(runReset, true);
  await app.close();
});

test("bulk retry requeues failed and budget-blocked requests in the current inbox", async () => {
  const retryableIds = [
    "60000000-0000-4000-8000-000000000002",
    "60000000-0000-4000-8000-000000000003",
  ];
  const retryableRunIds = [
    "50000000-0000-4000-8000-000000000002",
    "50000000-0000-4000-8000-000000000003",
  ];
  let resetProposalIds: unknown;
  let resetRunIds: unknown;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
      return { rows: [pluginSession()], rowCount: 1 };
    }
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.includes("pg_advisory_xact_lock")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM roblox_autofix_runs") &&
      sql.includes("status IN ('queued', 'processing')")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("SELECT proposal.id, proposal.run_id, proposal.status")
    ) {
      assert.deepEqual(values, [projectId, 15]);
      return {
        rows: [
          {
            failure_reason: null,
            id: "60000000-0000-4000-8000-000000000001",
            run_id: runId,
            status: "ready",
          },
          {
            failure_reason: "OpenRouter failed",
            id: retryableIds[0],
            run_id: retryableRunIds[0],
            status: "failed",
          },
          {
            failure_reason:
              "The batch reached Trace's strict token budget before this fix could be requested.",
            id: retryableIds[1],
            run_id: retryableRunIds[1],
            status: "unable",
          },
          {
            failure_reason: "Not enough source evidence",
            id: "60000000-0000-4000-8000-000000000004",
            run_id: "50000000-0000-4000-8000-000000000004",
            status: "unable",
          },
        ],
        rowCount: 4,
      };
    }
    if (sql.includes("DELETE FROM roblox_autofix_files")) {
      assert.deepEqual(values, [retryableIds]);
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("UPDATE roblox_autofix_proposals") &&
      sql.includes("WHERE id = ANY")
    ) {
      resetProposalIds = values[0];
      return { rows: [], rowCount: 2 };
    }
    if (
      sql.includes("UPDATE roblox_autofix_runs") &&
      sql.includes("WHERE id = ANY")
    ) {
      assert.match(sql, /input_tokens = 0/);
      assert.match(sql, /output_tokens = 0/);
      resetRunIds = values[0];
      return { rows: [], rowCount: 2 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4-nano" },
  );

  const response = await app.inject({
    method: "POST",
    url: "/v1/plugin-autofix/retry-failed",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { queued: 2, status: "queued" });
  assert.deepEqual(resetProposalIds, retryableIds);
  assert.deepEqual(resetRunIds, retryableRunIds);
  await app.close();
});

test("accepting a fix stores the exact Studio versions and reviewer in shared history", async () => {
  const proposalId = "60000000-0000-4000-8000-000000000001";
  const appliedFiles = [{
    path: "ServerScriptService.CashService",
    className: "Script" as const,
    previousSource: "return saveOnce()",
    appliedSource: "return saveWithRetry()",
  }];
  let savedHistoryValues: unknown[] | null = null;
  const reviewedAt = "2026-08-04T23:00:00.000Z";
  const query = async (sql: string) => {
    if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
      return { rows: [pluginSession()], rowCount: 1 };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id, status") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: proposalId, status: "ready" }], rowCount: 1 };
    }
    if (sql.includes("SELECT script_path, script_class")) {
      return {
        rows: [{
          script_path: appliedFiles[0].path,
          script_class: appliedFiles[0].className,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT credential.user_id")) {
      return {
        rows: [{
          user_id: "10000000-0000-4000-8000-000000000001",
          name: "BuilderDimitri",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("SET status = 'accepted'")) {
      return {
        rows: [{ id: proposalId, status: "accepted", reviewed_at: reviewedAt }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO roblox_autofix_history")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM roblox_autofix_history")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO roblox_autofix_history")) {
        savedHistoryValues = values;
      }
      return query(sql);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4-nano" },
  );

  const response = await app.inject({
    method: "POST",
    url: `/v1/plugin-autofix/proposals/${proposalId}/review`,
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
    payload: { action: "accepted", appliedFiles },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().historyCount, 1);
  assert.ok(savedHistoryValues);
  assert.equal(savedHistoryValues[2], appliedFiles[0].path);
  assert.equal(savedHistoryValues[4], appliedFiles[0].previousSource);
  assert.equal(savedHistoryValues[5], appliedFiles[0].appliedSource);
  assert.equal(savedHistoryValues[7], "BuilderDimitri");
  await app.close();
});

test("history is project-shared, timestamped, and limited to unexpired versions", async () => {
  const acceptedAt = "2026-08-04T23:00:00.000Z";
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("UPDATE roblox_plugin_credentials credentials")) {
        return { rows: [pluginSession()], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM roblox_autofix_history")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM roblox_autofix_history history")) {
        assert.deepEqual(values, [projectId]);
        assert.match(sql, /history\.expires_at > now\(\)/);
        return {
          rows: [{
            id: "70000000-0000-4000-8000-000000000001",
            proposal_id: "60000000-0000-4000-8000-000000000001",
            script_path: "ServerScriptService.CashService",
            script_class: "Script",
            accepted_by_name: "BuilderDimitri",
            accepted_at: acceptedAt,
            restored_by_name: null,
            restored_at: null,
            expires_at: "2026-08-11T23:00:00.000Z",
            title: "Retry transient saves",
            summary: "Issue: Save fails on transient 502 errors.\n\nFix: Retry the bounded update.",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "https://tracestack.gg",
    null,
    pool,
    null,
    { available: true, model: "openai/gpt-5.4-nano" },
  );

  const response = await app.inject({
    method: "GET",
    url: "/v1/plugin-autofix/history",
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().retentionDays, 7);
  assert.equal(response.json().entries[0].acceptedBy, "BuilderDimitri");
  assert.equal(response.json().entries[0].acceptedAt, acceptedAt);
  await app.close();
});
