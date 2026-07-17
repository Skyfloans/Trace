import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { FastifyRequest } from "fastify";
import { buildApp, ingestionRateLimitKey } from "../src/app.js";
import { findProjectForApiKey } from "../src/repository.js";
import {
  decodeCursor,
  encodeCursor,
  parseTimeRange,
  ReadApiError,
} from "../src/read/http.js";
import { getGameMetadata } from "../src/read/roblox.js";

test("Roblox games with bracketed update tags remain linkable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("games.roblox.com/v1/games")) {
      return new Response(JSON.stringify({
        data: [{ id: 8527226795, name: "[🍎💥] Eat a Fruit" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("thumbnails.roblox.com/v1/games/icons")) {
      return new Response(JSON.stringify({
        data: [{ state: "Completed", imageUrl: "https://example.com/game.png" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected Roblox URL: ${url}`);
  };

  assert.deepEqual(await getGameMetadata("8527226795"), {
    universeId: "8527226795",
    name: "[🍎💥] Eat a Fruit",
    iconUrl: "https://example.com/game.png",
  });
});

test("private Roblox games fall back to universe metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("games.roblox.com/v1/games")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("develop.roblox.com/v1/universes/multiget")) {
      return new Response(JSON.stringify({
        data: [{ id: 6890661035, name: "Kats Ideas", privacyType: "Private" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("thumbnails.roblox.com/v1/games/icons")) {
      return new Response(JSON.stringify({
        data: [{ state: "Completed", imageUrl: "https://example.com/private-game.png" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected Roblox URL: ${url}`);
  };

  assert.deepEqual(await getGameMetadata("6890661035"), {
    universeId: "6890661035",
    name: "Kats Ideas",
    iconUrl: "https://example.com/private-game.png",
  });
});

test("cursor round trips deterministic tie-breaker values", () => {
  const values = [42, "2026-07-13T23:41:54.000Z", "event-id"];
  assert.deepEqual(decodeCursor(encodeCursor(values)), values);
});

test("invalid cursors return a structured read error", () => {
  assert.throws(
    () => decodeCursor("not-a-cursor"),
    (error: unknown) =>
      error instanceof ReadApiError && error.code === "invalid_cursor",
  );
});

test("raw query ranges cannot exceed retention", () => {
  assert.throws(
    () =>
      parseTimeRange(
        "2026-07-01T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z",
      ),
    (error: unknown) =>
      error instanceof ReadApiError && error.code === "time_range_too_large",
  );
});

test("ingestion rejects events outside raw retention", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM project_api_keys")) {
        return {
          rows: [{ project_id: "20000000-0000-4000-8000-000000000001" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();

  const response = await app.inject({
    method: "POST",
    url: "/v1/batches",
    headers: { authorization: `Bearer ${"k".repeat(40)}` },
    payload: {
      version: 1,
      batchId: "10000000-0000-4000-8000-000000000001",
      job: {
        id: "20000000-0000-4000-8000-000000000001",
        robloxJobId: "job",
        placeId: "1",
        startedAt,
        lastSeenAt: startedAt,
      },
      sessions: [],
      events: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          occurredAt: startedAt,
          source: "server",
          level: "warning",
          message: "old warning",
        },
      ],
    },
  });

  assert.equal(response.statusCode, 422);
  assert.match(response.json().error, /24-hour raw retention/);
  await app.close();
});

test("ingestion rate limits are isolated per Roblox server job", () => {
  const makeRequest = (jobId: string) =>
    ({
      body: { job: { id: jobId } },
      headers: { authorization: `Bearer ${"k".repeat(40)}` },
      ip: "127.0.0.1",
    }) as FastifyRequest;

  const first = ingestionRateLimitKey(
    makeRequest("10000000-0000-4000-8000-000000000001"),
  );
  const sameJob = ingestionRateLimitKey(
    makeRequest("10000000-0000-4000-8000-000000000001"),
  );
  const otherJob = ingestionRateLimitKey(
    makeRequest("20000000-0000-4000-8000-000000000001"),
  );

  assert.equal(first, sameJob);
  assert.notEqual(first, otherJob);
});

test("valid ingestion keys reuse a short-lived project lookup", async () => {
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      return {
        rows: [{ project_id: "20000000-0000-4000-8000-000000000001" }],
        rowCount: 1,
      };
    },
  } as unknown as Pool;

  const key = "tr_ingest_test_key_that_is_long_enough";
  assert.equal(await findProjectForApiKey(pool, key), await findProjectForApiKey(pool, key));
  assert.equal(queries, 1);
});

test("read endpoints reject unauthenticated requests", async () => {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({ method: "GET", url: "/v1/projects" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthenticated");
  await app.close();
});

test("authenticated non-members cannot read another project", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              email: "member@example.com",
              name: "Member",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001",
    headers: {
      authorization: `Bearer ${"x".repeat(40)}`,
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "project_forbidden");
  await app.close();
});

test("read authentication and membership checks reuse short-lived cache", async () => {
  let authenticationQueries = 0;
  let membershipQueries = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        authenticationQueries += 1;
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              email: "member@example.com",
              name: "Member",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        membershipQueries += 1;
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("FROM projects")) {
        return {
          rows: [
            {
              id: "20000000-0000-4000-8000-000000000001",
              name: "Trace",
              roblox_universe_id: null,
              icon_url: null,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const request = {
    method: "GET" as const,
    url: "/v1/projects/20000000-0000-4000-8000-000000000001",
    headers: {
      authorization: `Bearer ${"x".repeat(40)}`,
    },
  };

  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(authenticationQueries, 1);
  assert.equal(membershipQueries, 1);
  await app.close();
});

test("activity queries combine raw occurrences with hourly rollups", async () => {
  let queriedRollups = false;
  const bucketAt = new Date();
  bucketAt.setUTCMinutes(0, 0, 0);
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              email: "member@example.com",
              name: "Member",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("occurrence_rollups_hourly")) {
        queriedRollups = true;
        return {
          rows: [
            {
              bucket_at: bucketAt,
              client_count: "12",
              server_count: "3",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/activity",
    headers: { authorization: `Bearer ${"z".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(queriedRollups, true);
  const bucket = response
    .json()
    .data.find((row: { startAt: string }) => row.startAt === bucketAt.toISOString());
  assert.deepEqual(bucket, {
    startAt: bucketAt.toISOString(),
    endAt: new Date(bucketAt.getTime() + 60 * 60 * 1_000).toISOString(),
    clientCount: 12,
    serverCount: 3,
  });
  await app.close();
});

test("logout is idempotent and always clears the browser session", async () => {
  let revoked = false;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("UPDATE web_sessions SET revoked_at")) {
        revoked = true;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const authenticated = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    cookies: { trace_session: "s".repeat(43) },
  });
  assert.equal(authenticated.statusCode, 204);
  assert.equal(revoked, true);
  assert.match(authenticated.headers["set-cookie"] ?? "", /trace_session=;/);

  const alreadySignedOut = await app.inject({ method: "POST", url: "/v1/auth/logout" });
  assert.equal(alreadySignedOut.statusCode, 204);
  assert.match(alreadySignedOut.headers["set-cookie"] ?? "", /trace_session=;/);
  await app.close();
});

test("browser session cookie takes precedence over a development bearer token", async () => {
  const browserToken = "browser-session-".padEnd(40, "b");
  const developerToken = "developer-session-".padEnd(40, "d");
  const browserHash = createHash("sha256").update(browserToken).digest("hex");
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        const tokenHash = values?.[0];
        assert.ok(Buffer.isBuffer(tokenHash));
        const isBrowserSession = tokenHash.toString("hex") === browserHash;
        return {
          rows: [{
            id: isBrowserSession
              ? "10000000-0000-4000-8000-000000000001"
              : "20000000-0000-4000-8000-000000000001",
            email: null,
            name: isBrowserSession ? "Sky" : "Trace Developer",
            robloxUserId: isBrowserSession ? "190970206" : null,
            robloxUsername: isBrowserSession ? "skyfloans" : null,
            robloxDisplayName: isBrowserSession ? "Sky" : null,
            robloxAvatarUrl: isBrowserSession ? "https://example.com/sky.png" : null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: { authorization: `Bearer ${developerToken}` },
    cookies: { trace_session: browserToken },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.robloxUsername, "skyfloans");
  assert.equal(response.json().user.robloxAvatarUrl, "https://example.com/sky.png");
  await app.close();
});

test("Roblox OAuth reports when deployment credentials are not configured", async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({ method: "GET", url: "/v1/auth/roblox/start" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "oauth_not_configured");
  await app.close();
});

test("claim verification requires an authenticated Trace account", async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const app = await buildApp(pool, "http://localhost:5173", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/v1/auth/roblox/callback",
  });
  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/roblox/start?intent=claim&universeId=123",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "claim_sign_in_required");
  await app.close();
});

test("Roblox OAuth start binds PKCE state to an HttpOnly browser cookie", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "http://localhost:5173", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:5173/api/v1/auth/roblox/callback",
  });
  const response = await app.inject({ method: "GET", url: "/v1/auth/roblox/start" });

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.location!, /^https:\/\/apis\.roblox\.com\/oauth\/v1\/authorize\?/);
  assert.match(String(response.headers["set-cookie"]), /trace_oauth_binding=.*HttpOnly/);
  assert.match(
    String(response.headers["set-cookie"]),
    /Path=\/api\/v1\/auth\/roblox\/callback/,
  );
  assert.equal(queries.some((sql) => sql.includes("browser_binding_hash")), true);
  await app.close();
});

test("Roblox OAuth callback rejects a flow started in another browser", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("DELETE FROM roblox_oauth_flows")) {
        return {
          rows: [{
            browser_binding_hash: Buffer.alloc(32, 1),
            user_id: null,
            intent: "login",
            universe_id: null,
            code_verifier: "v".repeat(48),
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "http://localhost:5173", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:5173/api/v1/auth/roblox/callback",
  });
  const response = await app.inject({
    method: "GET",
    url: `/v1/auth/roblox/callback?code=test-code&state=${"s".repeat(40)}`,
  });

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.location!, /oauthError=oauth_browser_mismatch/);
  await app.close();
});

test("Roblox OAuth stores a headshot when userinfo omits the picture claim", async (t) => {
  const originalFetch = globalThis.fetch;
  const browserBinding = "browser-binding".padEnd(40, "b");
  let storedAvatarUrl: unknown;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/v1/token")) {
      return new Response(JSON.stringify({ access_token: "roblox-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/oauth/v1/userinfo")) {
      return new Response(JSON.stringify({
        sub: "190970206",
        preferred_username: "skyfloans",
        nickname: "Sky",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("thumbnails.roblox.com/v1/users/avatar-headshot")) {
      return new Response(JSON.stringify({
        data: [{ state: "Completed", imageUrl: "https://example.com/sky.png" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected Roblox URL: ${url}`);
  };

  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("DELETE FROM roblox_oauth_flows")) {
        return {
          rows: [{
            browser_binding_hash: createHash("sha256").update(browserBinding).digest(),
            user_id: null,
            intent: "login",
            universe_id: null,
            code_verifier: "v".repeat(48),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO users")) {
        storedAvatarUrl = values?.[3];
        return {
          rows: [{ id: "10000000-0000-4000-8000-000000000001" }],
          rowCount: 1,
        };
      }
      if (sql.includes("WITH accepted AS")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO web_sessions")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "http://localhost:5173", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:5173/api/v1/auth/roblox/callback",
  });
  const response = await app.inject({
    method: "GET",
    url: `/v1/auth/roblox/callback?code=test-code&state=${"s".repeat(40)}`,
    cookies: { trace_oauth_binding: browserBinding },
  });

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.location!, /signedIn=true/);
  assert.equal(storedAvatarUrl, "https://example.com/sky.png");
  await app.close();
});

test("Roblox invitation lookup returns the resolved account and avatar", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("users.roblox.com/v1/usernames/users")) {
      return new Response(JSON.stringify({
        data: [{ id: 190970206, name: "skyfloans", displayName: "Sky" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("thumbnails.roblox.com/v1/users/avatar-headshot")) {
      return new Response(JSON.stringify({
        data: [{ state: "Completed", imageUrl: "https://example.com/sky.png" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected Roblox URL: ${url}`);
  };

  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Owner",
            robloxUserId: "123",
            robloxUsername: "owner",
            robloxDisplayName: "Owner",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "GET",
    url: "/v1/manage/roblox-users/skyfloans",
    headers: { authorization: `Bearer ${"u".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    id: "190970206",
    name: "skyfloans",
    displayName: "Sky",
    avatarUrl: "https://example.com/sky.png",
  });
  await app.close();
});

test("feedback is returned with player and session attribution", async () => {
  const submittedAt = new Date();
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000001", email: "member@example.com", name: "Member" }], rowCount: 1 };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("FROM feedback f")) {
        return { rows: [{
          id: "30000000-0000-4000-8000-000000000001",
          message: "The round timer feels too long.",
          submitted_at: submittedAt,
          session_id: "40000000-0000-4000-8000-000000000001",
          player_id: "123",
          player_name: "skyfloans",
          player_display_name: "Sky",
          device: "desktop",
          platform: null,
        }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/feedback",
    headers: { authorization: `Bearer ${"f".repeat(40)}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data[0], {
    id: "30000000-0000-4000-8000-000000000001",
    message: "The round timer feels too long.",
    submittedAt: submittedAt.toISOString(),
    sessionId: "40000000-0000-4000-8000-000000000001",
    player: { robloxUserId: "123", username: "skyfloans", displayName: "Sky", avatarUrl: null },
    device: "desktop",
  });
  await app.close();
});

test("player headshots are fetched from Roblox in one batch", async () => {
  const originalFetch = globalThis.fetch;
  let robloxRequests = 0;
  globalThis.fetch = async () => {
    robloxRequests += 1;
    return new Response(
      JSON.stringify({
        data: [
          { targetId: 123, state: "Completed", imageUrl: "https://example.com/123.png" },
          { targetId: 456, state: "Completed", imageUrl: "https://example.com/456.png" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              email: "member@example.com",
              name: "Member",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT DISTINCT player_id::text")) {
        return {
          rows: [{ player_id: "123" }, { player_id: "456" }],
          rowCount: 2,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/projects/20000000-0000-4000-8000-000000000001/player-headshots?ids=123,456",
      headers: {
        authorization: `Bearer ${"y".repeat(40)}`,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, {
      "123": "https://example.com/123.png",
      "456": "https://example.com/456.png",
    });
    assert.equal(robloxRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
