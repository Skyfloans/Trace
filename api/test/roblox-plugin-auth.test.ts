import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { buildApp } from "../src/app.js";

const userId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const credentialId = "30000000-0000-4000-8000-000000000001";
const robloxUserId = "190970206";
const sourceUniverseId = "10454554751";
const targetUniverseId = "10587551620";
const studioPlaceId = "72980619319007";
const installId = "3b073c13-0a34-4c82-bf1f-6dcc8c9ae112";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

test("Studio pairing binds the website approval to a client proof and one-time code", async () => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000);
  const credentialExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000);
  const pairing = {
    id: "",
    client_proof_hash: Buffer.alloc(0),
    roblox_user_id: robloxUserId,
    studio_universe_id: targetUniverseId,
    studio_place_id: studioPlaceId,
    install_id: installId,
    status: "pending" as "pending" | "approved" | "consumed" | "expired",
    project_id: null as string | null,
    code_hash: null as Buffer | null,
    attempt_count: 0,
    expires_at: expiresAt,
  };
  let storedBrowserTokenHash: Buffer | null = null;
  let storedCredentialHash: Buffer | null = null;

  const eligibleProject = {
    id: projectId,
    name: "Unbox ASMR!",
    roblox_universe_id: sourceUniverseId,
    icon_url: null,
    target_universe_id: targetUniverseId,
  };

  const query = async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM web_sessions")) {
      return {
        rows: [{
          id: userId,
          email: null,
          name: "Sky",
          robloxUserId,
          robloxUsername: "skyfloans",
          robloxDisplayName: "Sky",
          robloxAvatarUrl: null,
        }],
        rowCount: 1,
      };
    }
    if (
      sql.includes("UPDATE roblox_plugin_pairing_requests") &&
      sql.includes("expires_at <= now()")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO roblox_plugin_pairing_requests")) {
      pairing.id = String(values[0]);
      storedBrowserTokenHash = values[1] as Buffer;
      pairing.client_proof_hash = values[2] as Buffer;
      return {
        rows: [{ id: pairing.id, expires_at: expiresAt }],
        rowCount: 1,
      };
    }
    if (
      sql.includes("FROM roblox_plugin_pairing_requests") &&
      sql.trimStart().startsWith("SELECT")
    ) {
      return { rows: [{ ...pairing }], rowCount: 1 };
    }
    if (sql.includes("FROM projects p") && sql.includes("grant_access")) {
      return { rows: [eligibleProject], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE roblox_plugin_pairing_requests") &&
      sql.includes("status = 'approved'")
    ) {
      pairing.status = "approved";
      pairing.project_id = String(values[1]);
      pairing.code_hash = values[3] as Buffer;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM projects") && sql.includes("roblox_universe_id IS NOT NULL")) {
      return {
        rows: [{
          id: projectId,
          name: eligibleProject.name,
          icon_url: null,
          roblox_universe_id: sourceUniverseId,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO roblox_plugin_credentials")) {
      storedCredentialHash = values[0] as Buffer;
      return {
        rows: [{ id: credentialId, expires_at: credentialExpiresAt }],
        rowCount: 1,
      };
    }
    if (
      sql.includes("UPDATE roblox_plugin_credentials") &&
      sql.includes("roblox_plugin_pairing_requests pairing")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("UPDATE roblox_plugin_pairing_requests") &&
      sql.includes("status = 'consumed'")
    ) {
      pairing.status = "consumed";
      pairing.code_hash = null;
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
  );

  const started = await app.inject({
    method: "POST",
    url: "/v1/plugin-auth/requests",
    payload: {
      robloxUserId,
      studioUniverseId: targetUniverseId,
      studioPlaceId,
      installId,
    },
  });
  assert.equal(started.statusCode, 201);
  const startBody = started.json();
  assert.match(startBody.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(
    new URL(startBody.browserUrl).origin,
    "https://tracestack.gg",
  );
  assert.equal(storedBrowserTokenHash instanceof Buffer, true);
  assert.equal(pairing.client_proof_hash.equals(sha256(startBody.clientProof)), true);
  assert.notEqual(pairing.client_proof_hash.toString("utf8"), startBody.clientProof);

  const preview = await app.inject({
    method: "GET",
    url: `/v1/manage/plugin-auth/${new URL(startBody.browserUrl).searchParams.get("token")}`,
    cookies: { trace_session: "s".repeat(40) },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().projects[0].id, projectId);
  assert.equal(preview.json().projects[0].targetUniverseId, targetUniverseId);

  const approved = await app.inject({
    method: "POST",
    url: `/v1/manage/plugin-auth/${new URL(startBody.browserUrl).searchParams.get("token")}/approve`,
    cookies: { trace_session: "s".repeat(40) },
    payload: { projectId },
  });
  assert.equal(approved.statusCode, 200);
  const code = approved.json().code as string;
  assert.match(code, /^\d{2}$/);
  assert.equal(pairing.code_hash?.equals(sha256(`${pairing.id}:${code}`)), true);

  const verified = await app.inject({
    method: "POST",
    url: `/v1/plugin-auth/requests/${startBody.requestId}/verify`,
    payload: {
      clientProof: startBody.clientProof,
      code,
    },
  });
  assert.equal(verified.statusCode, 200);
  const verifiedBody = verified.json();
  assert.equal(verifiedBody.project.id, projectId);
  assert.equal(verifiedBody.project.robloxUniverseId, sourceUniverseId);
  assert.equal(verifiedBody.targetUniverseId, targetUniverseId);
  assert.equal(storedCredentialHash?.equals(sha256(verifiedBody.token)), true);
  assert.equal(pairing.status, "consumed");

  await app.close();
});

test("Studio pairing rejects an approval from a different Roblox account", async () => {
  const pairing = {
    id: "40000000-0000-4000-8000-000000000001",
    client_proof_hash: sha256("proof"),
    roblox_user_id: "999999999",
    studio_universe_id: targetUniverseId,
    studio_place_id: studioPlaceId,
    install_id: installId,
    status: "pending",
    project_id: null,
    code_hash: null,
    attempt_count: 0,
    expires_at: new Date(Date.now() + 60_000),
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: userId,
            robloxUserId,
            robloxUsername: "skyfloans",
          }],
          rowCount: 1,
        };
      }
      if (
        sql.includes("UPDATE roblox_plugin_pairing_requests") &&
        sql.includes("expires_at <= now()")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM roblox_plugin_pairing_requests")) {
        return { rows: [pairing], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "https://tracestack.gg", null, pool);

  const response = await app.inject({
    method: "GET",
    url: `/v1/manage/plugin-auth/${"b".repeat(43)}`,
    cookies: { trace_session: "s".repeat(40) },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "plugin_pairing_account_mismatch");
  await app.close();
});
