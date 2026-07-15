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
