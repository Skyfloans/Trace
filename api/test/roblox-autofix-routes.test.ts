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

test("a reviewable proposal can be regenerated in its existing queue slot", async () => {
  let proposalReset = false;
  let runReset = false;
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
        rows: [{ run_id: runId, status: "ready" }],
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
      return { rows: [{ count: 15 }], rowCount: 1 };
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
  await app.close();
});
