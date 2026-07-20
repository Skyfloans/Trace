import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import type { Pool } from "pg";
import type { FastifyRequest } from "fastify";
import type { ArchiveStorage } from "../src/archive-storage.js";
import { buildApp, ingestionRateLimitKey } from "../src/app.js";
import { findProjectForApiKey, ingestBatch, verifyProjectUniverse } from "../src/repository.js";
import { ingestBatchSchema } from "../src/schema.js";
import {
  decodeCursor,
  encodeCursor,
  parseTimeRange,
  ReadApiError,
} from "../src/read/http.js";
import { sessionCountJoin } from "../src/read/mappers.js";
import { getGameMetadata } from "../src/read/roblox.js";

test("ingestion updates raw occurrences and live hourly totals atomically", async () => {
  let occurrenceSql = "";
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("hashtextextended('trace-job:")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("WITH project_update AS")) {
        return {
          rows: [{ id: "30000000-0000-4000-8000-000000000001" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT pg_advisory_xact_lock(") && sql.includes("ordered.fingerprint")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO error_groups")) {
        const groups = JSON.parse(String(values?.[1])) as Array<{ fingerprint: string }>;
        return {
          rows: [{
            id: "40000000-0000-4000-8000-000000000001",
            fingerprint: groups[0].fingerprint,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO occurrences")) {
        occurrenceSql = sql;
        return { rows: [{ accepted: 1 }], rowCount: 1 };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const batch = ingestBatchSchema.parse({
    version: 1,
    batchId: "50000000-0000-4000-8000-000000000001",
    job: {
      id: "30000000-0000-4000-8000-000000000001",
      robloxJobId: "roblox-job",
      placeId: "1",
      universeId: "2",
      startedAt: "2026-07-20T10:00:00.000Z",
      lastSeenAt: "2026-07-20T10:01:00.000Z",
    },
    sessions: [],
    events: [{
      id: "60000000-0000-4000-8000-000000000001",
      occurredAt: "2026-07-20T10:00:30.000Z",
      repeatCount: 1,
      source: "server",
      level: "warning",
      message: "DataStore request entered the queue",
    }],
    feedback: [],
  });

  assert.deepEqual(
    await ingestBatch(pool, "20000000-0000-4000-8000-000000000001", batch),
    { accepted: 1, duplicates: 0 },
  );
  assert.match(occurrenceSql, /inserted AS \(\s+INSERT INTO occurrences/);
  assert.match(occurrenceSql, /live_rollups AS \(\s+INSERT INTO occurrence_rollups_hourly/);
  assert.match(
    occurrenceSql,
    /event_count = occurrence_rollups_hourly\.event_count \+ EXCLUDED\.event_count/,
  );
  assert.match(occurrenceSql, /SELECT COUNT\(\*\) FROM live_rollups/);
  assert.equal(released, true);
});

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

test("the first matching ingestion verifies a linked universe", async () => {
  const projectId = "20000000-0000-4000-8000-000000000001";
  let queries = 0;
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      queries += 1;
      assert.match(sql, /roblox_universe_id/);
      assert.deepEqual(values, [projectId, "10395108329"]);
      return { rows: [{ matches: true }], rowCount: 1 };
    },
  } as unknown as Pool;

  assert.equal(await verifyProjectUniverse(pool, projectId, "10395108329"), true);
  assert.equal(await verifyProjectUniverse(pool, projectId, "10395108329"), true);
  assert.equal(queries, 1);
});

test("ingestion from a different universe cannot verify a linked game", async () => {
  const pool = {
    query: async () => ({ rows: [{ matches: false }], rowCount: 1 }),
  } as unknown as Pool;

  assert.equal(
    await verifyProjectUniverse(pool, "20000000-0000-4000-8000-000000000001", "999"),
    false,
  );
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

test("health checks and portal reads use reserved database capacity", async () => {
  const ingestionPool = {
    query: async () => {
      throw new Error("Health check used the ingestion pool");
    },
  } as unknown as Pool;
  let readQueries = 0;
  const readPool = {
    query: async () => {
      readQueries += 1;
      return { rows: [{ value: 1 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const app = await buildApp(
    ingestionPool,
    "http://localhost:5173",
    null,
    readPool,
  );

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(readQueries, 1);
  await app.close();
});

test("session timelines include every server event across the full session", async () => {
  let timelineSql = "";
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: "member@example.com",
            name: "Member",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT job_id, started_at")) {
        return {
          rows: [
            {
              job_id: "40000000-0000-4000-8000-000000000001",
              started_at: "2026-07-18T12:00:00.000Z",
              ended_at: "2026-07-18T13:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("WITH target_session AS")) {
        timelineSql = sql;
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/sessions/30000000-0000-4000-8000-000000000001/timeline?includeAllServer=true",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.match(timelineSql, /COALESCE\(ended_at, now\(\)\)/);
  assert.match(timelineSql, /LEFT JOIN LATERAL/);
  assert.match(timelineSql, /server_event\.session_id IS DISTINCT FROM ts\.id/);
  assert.match(timelineSql, /server_group\.source = 'server'/);
  assert.match(timelineSql, /UNION SELECT \* FROM filtered WHERE source = 'server'/);
  await app.close();
});

test("session counts combine direct client events with server events in the session window", () => {
  assert.match(sessionCountJoin, /o\.session_id = s\.id/);
  assert.match(sessionCountJoin, /server_group\.source = 'server'/);
  assert.match(sessionCountJoin, /o\.job_id = s\.job_id/);
  assert.match(sessionCountJoin, /o\.session_id IS DISTINCT FROM s\.id/);
  assert.match(
    sessionCountJoin,
    /o\.occurred_at BETWEEN s\.started_at AND COALESCE\(s\.ended_at, now\(\)\)/,
  );
});

test("session timelines merge verified archived server events", async () => {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const sessionId = "30000000-0000-4000-8000-000000000001";
  const jobId = "40000000-0000-4000-8000-000000000001";
  const sessionStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
  sessionStart.setUTCHours(12, 0, 0, 0);
  const sessionEnd = new Date(sessionStart.getTime() + 60 * 60 * 1_000);
  const occurrenceTime = new Date(sessionStart.getTime() + 30 * 60 * 1_000);
  const partitionDate = sessionStart.toISOString().slice(0, 10);
  const occurrence = {
    id: "50000000-0000-4000-8000-000000000001",
    projectId,
    occurredAt: occurrenceTime.toISOString(),
    lastOccurredAt: occurrenceTime.toISOString(),
    repeatCount: 1,
    receivedAt: new Date(occurrenceTime.getTime() + 1_000).toISOString(),
    severity: "error",
    side: "server",
    message: "archived server error",
    source: null,
    stackTrace: null,
    fingerprint: "archived-fingerprint",
    serverJobId: jobId,
    sessionId: null,
    player: null,
    attributes: {},
  };
  const chunk = gzipSync(
    JSON.stringify({ version: 1, occurrences: [occurrence] }),
  );
  const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      partition: `occurrences_${partitionDate.replaceAll("-", "_")}`,
      partitionDate,
      archivedAt: new Date().toISOString(),
      occurrenceCount: 1,
      chunks: [
        {
          bytes: chunk.byteLength,
          count: 1,
          firstOccurredAt: occurrence.occurredAt,
          lastOccurredAt: occurrence.lastOccurredAt,
          jobId,
          key: "archive/chunk.json.gz",
          projectId,
          sha256: chunkSha256,
        },
        {
          bytes: chunk.byteLength,
          count: 1,
          firstOccurredAt: new Date(sessionStart.getTime() - 2 * 60 * 60 * 1_000).toISOString(),
          lastOccurredAt: new Date(sessionStart.getTime() - 60 * 60 * 1_000).toISOString(),
          jobId,
          key: "archive/non-overlapping.json.gz",
          projectId,
          sha256: chunkSha256,
        },
      ],
    }),
  );
  const archiveStorage = {
    key: (relativeKey: string) => `archive/${relativeKey}`,
    get: async (key: string) => {
      if (key.endsWith("non-overlapping.json.gz")) {
        throw new Error("non-overlapping archive chunk should not be downloaded");
      }
      return key.endsWith("manifest.json")
        ? manifest
        : key.endsWith("chunk.json.gz")
          ? chunk
          : null;
    },
  } as unknown as ArchiveStorage;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{ id: "10000000-0000-4000-8000-000000000001" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT job_id, started_at")) {
        return {
          rows: [
            {
              job_id: jobId,
              started_at: sessionStart.toISOString(),
              ended_at: sessionEnd.toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("WITH target_session AS")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "http://localhost:5173",
    null,
    pool,
    archiveStorage,
  );

  const response = await app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/sessions/${sessionId}/timeline?includeAllServer=true`,
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.map((item: { id: string }) => item.id), [
    occurrence.id,
  ]);
  await app.close();
});

test("recent session timelines skip archive storage", async () => {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const sessionId = "30000000-0000-4000-8000-000000000001";
  const jobId = "40000000-0000-4000-8000-000000000001";
  const startedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  const endedAt = new Date().toISOString();
  let archiveReads = 0;
  const archiveStorage = {
    key: (relativeKey: string) => `archive/${relativeKey}`,
    get: async () => {
      archiveReads += 1;
      return null;
    },
  } as unknown as ArchiveStorage;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{ id: "10000000-0000-4000-8000-000000000001" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT job_id, started_at")) {
        return {
          rows: [{ job_id: jobId, started_at: startedAt, ended_at: endedAt }],
          rowCount: 1,
        };
      }
      if (sql.includes("WITH target_session AS")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(
    pool,
    "http://localhost:5173",
    null,
    pool,
    archiveStorage,
  );

  const response = await app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/sessions/${sessionId}/timeline?includeAllServer=true`,
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(archiveReads, 0);
  await app.close();
});

test("recent players scan newest sessions and stop after filling the page", async () => {
  let playersSql = "";
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: "member@example.com",
            name: "Member",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("ORDER BY s.started_at DESC, s.id DESC")) {
        playersSql = sql;
        return {
          rows: [
            {
              id: "30000000-0000-4000-8000-000000000001",
              player_id: "123",
              player_name: "LatestPlayer",
              player_display_name: "Latest Player",
              avatar_url: null,
              started_at: "2026-07-20T12:00:00.000Z",
              last_seen_at: "2026-07-20T12:10:00.000Z",
            },
            {
              id: "30000000-0000-4000-8000-000000000002",
              player_id: "123",
              player_name: "OlderPlayerName",
              player_display_name: "Older Player Name",
              avatar_url: null,
              started_at: "2026-07-20T11:00:00.000Z",
              last_seen_at: "2026-07-20T11:10:00.000Z",
            },
            {
              id: "30000000-0000-4000-8000-000000000003",
              player_id: "456",
              player_name: "SecondPlayer",
              player_display_name: "Second Player",
              avatar_url: null,
              started_at: "2026-07-20T10:00:00.000Z",
              last_seen_at: "2026-07-20T10:10:00.000Z",
            },
          ],
          rowCount: 3,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/players?limit=50",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.match(playersSql, /WHERE s\.project_id = \$1/);
  assert.match(playersSql, /\(s\.started_at, s\.id\) < \(\$2, \$3::uuid\)/);
  assert.match(playersSql, /ORDER BY s\.started_at DESC, s\.id DESC/);
  assert.doesNotMatch(playersSql, /DISTINCT ON/);
  assert.deepEqual(
    response.json().data.map((player: { username: string }) => player.username),
    ["LatestPlayer", "SecondPlayer"],
  );
  await app.close();
});

test("grouped logs bound candidate groups before calculating exact statistics", async () => {
  let groupsSql = "";
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: "member@example.com",
            name: "Member",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("to_regclass('public.trace_read_model_state')")) {
        return { rows: [{ relation: null }], rowCount: 1 };
      }
      if (sql.includes("WITH candidate_groups AS")) {
        groupsSql = sql;
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/errors?severity=error,warning&sort=recent&limit=25",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.match(groupsSql, /FROM error_groups eg/);
  assert.match(groupsSql, /eg\.last_seen_at >= \$\d+/);
  assert.match(groupsSql, /ORDER BY eg\.last_seen_at DESC, eg\.id DESC\s+LIMIT \$\d+/);
  assert.match(groupsSql, /o\.group_id = candidate_groups\.group_id/);
  assert.match(groupsSql, /JOIN LATERAL/);
  assert.doesNotMatch(groupsSql, /ORDER BY event_count DESC/);
  await app.close();
});

test("grouped logs use hourly summaries and raw partial-hour edges", async () => {
  let groupsSql = "";
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: "member@example.com",
            name: "Member",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("to_regclass('public.trace_read_model_state')")) {
        return { rows: [{ relation: "trace_read_model_state" }], rowCount: 1 };
      }
      if (sql.includes("FROM trace_read_model_state")) {
        return { rows: [{ ready: true }], rowCount: 1 };
      }
      if (sql.includes("WITH combined AS")) {
        groupsSql = sql;
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);

  const response = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/errors?severity=error,warning&sort=recent&limit=25&from=2026-07-20T10:15:00.000Z&to=2026-07-20T13:45:00.000Z",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.match(groupsSql, /FROM occurrence_rollups_hourly r/);
  assert.match(groupsSql, /r\.bucket_at >= \$\d+/);
  assert.match(groupsSql, /UNION ALL/);
  assert.match(groupsSql, /FROM occurrences o/);
  assert.match(groupsSql, /AND NOT \(/);
  assert.match(groupsSql, /ORDER BY last_seen_at DESC, group_id DESC/);
  assert.doesNotMatch(groupsSql, /COUNT\(DISTINCT/);
  assert.doesNotMatch(groupsSql, /JOIN sessions/);

  const aligned = await app.inject({
    method: "GET",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/errors?severity=error,warning&sort=recent&limit=25&from=2026-07-20T10:00:00.000Z&to=2026-07-20T14:00:00.000Z",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });
  assert.equal(aligned.statusCode, 200);
  assert.match(groupsSql, /FROM occurrence_rollups_hourly r/);
  assert.doesNotMatch(groupsSql, /FROM occurrences o/);
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
  let activitySql = "";
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
      if (sql.includes("to_regclass('public.trace_read_model_state')")) {
        return { rows: [{ relation: "trace_read_model_state" }], rowCount: 1 };
      }
      if (sql.includes("FROM trace_read_model_state")) {
        return { rows: [{ ready: true }], rowCount: 1 };
      }
      if (sql.includes("occurrence_rollups_hourly")) {
        activitySql = sql;
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
  assert.match(activitySql, /FROM occurrences o/);
  assert.match(activitySql, /FROM occurrence_rollups_hourly r/);
  assert.match(activitySql, /AND NOT \(/);
  assert.match(activitySql, /UNION ALL/);
  const bucket = response
    .json()
    .data.find((row: { startAt: string }) => row.startAt === bucketAt.toISOString());
  assert.deepEqual(bucket, {
    startAt: bucketAt.toISOString(),
    endAt: new Date(bucketAt.getTime() + 60 * 60 * 1_000).toISOString(),
    clientCount: 12,
    serverCount: 3,
  });

  const alignedFrom = new Date(bucketAt.getTime() - 23 * 60 * 60 * 1_000);
  const alignedTo = new Date(bucketAt.getTime() + 60 * 60 * 1_000);
  const aligned = await app.inject({
    method: "GET",
    url: `/v1/projects/20000000-0000-4000-8000-000000000001/activity?from=${encodeURIComponent(alignedFrom.toISOString())}&to=${encodeURIComponent(alignedTo.toISOString())}`,
    headers: { authorization: `Bearer ${"z".repeat(40)}` },
  });
  assert.equal(aligned.statusCode, 200);
  assert.match(activitySql, /FROM occurrence_rollups_hourly r/);
  assert.doesNotMatch(activitySql, /FROM occurrences o/);
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
  assert.equal(response.headers["cache-control"], "private, no-store");
  await app.close();
});

test("project membership lists are never reused across browser accounts", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Ralph",
            robloxUserId: "123",
            robloxUsername: "HowdIFindThisGame",
            robloxDisplayName: "ralph",
            robloxAvatarUrl: "https://example.com/ralph.png",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM projects p")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "GET",
    url: "/v1/projects",
    cookies: { trace_session: "r".repeat(40) },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: [] });
  assert.equal(response.headers["cache-control"], "private, no-store");
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
  assert.equal(new URL(response.headers.location!).pathname, "/");
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
  assert.equal(new URL(response.headers.location!).pathname, "/dashboard");
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

test("pending invitations are listed for the signed-in Roblox account", async () => {
  const createdAt = new Date();
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Sky",
            robloxUserId: "190970206",
            robloxUsername: "skyfloans",
            robloxDisplayName: "Sky",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_invitations inv")) {
        assert.deepEqual(values, ["190970206"]);
        return {
          rows: [{
            id: "30000000-0000-4000-8000-000000000001",
            role: "viewer",
            created_at: createdAt,
            project_id: "20000000-0000-4000-8000-000000000001",
            project_name: "Nuke RNG",
            roblox_universe_id: "10395108329",
            icon_url: "https://example.com/game.png",
            inviter_username: "owner",
            inviter_display_name: "Game Owner",
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
    url: "/v1/invitations",
    headers: { authorization: `Bearer ${"i".repeat(40)}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json().data, [{
    id: "30000000-0000-4000-8000-000000000001",
    role: "viewer",
    createdAt: createdAt.toISOString(),
    project: {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Nuke RNG",
      robloxUniverseId: "10395108329",
      iconUrl: "https://example.com/game.png",
    },
    invitedBy: { username: "owner", displayName: "Game Owner" },
  }]);
  await app.close();
});

test("accepting an invitation atomically grants project membership", async () => {
  const transactionQueries: string[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      transactionQueries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE project_invitations")) {
        assert.deepEqual(values, [
          "10000000-0000-4000-8000-000000000001",
          "30000000-0000-4000-8000-000000000001",
          "190970206",
        ]);
        return {
          rows: [{ project_id: "20000000-0000-4000-8000-000000000001", role: "viewer" }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO project_memberships")) {
        assert.deepEqual(values, [
          "10000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000001",
          "viewer",
        ]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Sky",
            robloxUserId: "190970206",
            robloxUsername: "skyfloans",
            robloxDisplayName: "Sky",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "POST",
    url: "/v1/invitations/30000000-0000-4000-8000-000000000001/accept",
    headers: { authorization: `Bearer ${"a".repeat(40)}` },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(transactionQueries.includes("COMMIT"), true);
  assert.equal(transactionQueries.includes("ROLLBACK"), false);
  await app.close();
});

test("declining an invitation closes it without granting membership", async () => {
  let grantedMembership = false;
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Sky",
            robloxUserId: "190970206",
            robloxUsername: "skyfloans",
            robloxDisplayName: "Sky",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE project_invitations")) {
        assert.deepEqual(values, ["30000000-0000-4000-8000-000000000001", "190970206"]);
        return { rows: [{ id: "30000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO project_memberships")) grantedMembership = true;
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "POST",
    url: "/v1/invitations/30000000-0000-4000-8000-000000000001/decline",
    headers: { authorization: `Bearer ${"d".repeat(40)}` },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(grantedMembership, false);
  await app.close();
});

test("a non-owner can leave a project and revoke their accepted invitation", async () => {
  const transactionQueries: string[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      transactionQueries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT role FROM project_memberships")) {
        assert.deepEqual(values, [
          "10000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000001",
        ]);
        return { rows: [{ role: "viewer" }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM project_memberships")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE project_invitations")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            email: null,
            name: "Viewer",
            robloxUserId: "190970206",
            robloxUsername: "viewer",
            robloxDisplayName: "Viewer",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "DELETE",
    url: "/v1/projects/20000000-0000-4000-8000-000000000001/membership",
    headers: { authorization: `Bearer ${"l".repeat(40)}` },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(transactionQueries.includes("COMMIT"), true);
  assert.equal(transactionQueries.some((sql) => sql.includes("DELETE FROM project_memberships")), true);
  assert.equal(transactionQueries.some((sql) => sql.includes("UPDATE project_invitations")), true);
  await app.close();
});

test("admins can remove viewers but cannot remove another admin", async () => {
  const actorId = "10000000-0000-4000-8000-000000000001";
  const otherAdminId = "30000000-0000-4000-8000-000000000001";
  const viewerId = "40000000-0000-4000-8000-000000000001";
  let membershipDeletes = 0;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT role FROM project_memberships")) {
        const userId = values?.[0];
        if (userId === actorId) return { rows: [{ role: "admin" }], rowCount: 1 };
        if (userId === otherAdminId) return { rows: [{ role: "admin" }], rowCount: 1 };
        if (userId === viewerId) return { rows: [{ role: "viewer" }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM project_memberships")) {
        membershipDeletes += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE project_invitations")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: actorId,
            email: null,
            name: "Admin",
            robloxUserId: "123",
            robloxUsername: "admin",
            robloxDisplayName: "Admin",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  const app = await buildApp(pool);
  const headers = { authorization: `Bearer ${"m".repeat(40)}` };

  const forbidden = await app.inject({
    method: "DELETE",
    url: `/v1/manage/projects/20000000-0000-4000-8000-000000000001/members/${otherAdminId}`,
    headers,
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "member_rank_forbidden");

  const removed = await app.inject({
    method: "DELETE",
    url: `/v1/manage/projects/20000000-0000-4000-8000-000000000001/members/${viewerId}`,
    headers,
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(membershipDeletes, 1);
  await app.close();
});

test("only an owner can permanently delete a project", async () => {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const userId = "10000000-0000-4000-8000-000000000001";
  let deleted = false;
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{ id: userId, name: "Owner", robloxUserId: "123" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT role") && sql.includes("FROM project_memberships")) {
        assert.deepEqual(values, [userId, projectId]);
        return { rows: [{ role: "owner" }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM projects")) {
        assert.deepEqual(values, [projectId]);
        deleted = true;
        return { rows: [{ id: projectId }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "DELETE",
    url: `/v1/manage/projects/${projectId}`,
    headers: { authorization: `Bearer ${"o".repeat(40)}` },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(deleted, true);
  await app.close();
});

test("an admin cannot delete a project", async () => {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM web_sessions")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000001", name: "Admin" }], rowCount: 1 };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ role: "admin" }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM projects")) throw new Error("Admin reached project deletion");
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool);
  const response = await app.inject({
    method: "DELETE",
    url: `/v1/manage/projects/${projectId}`,
    headers: { authorization: `Bearer ${"a".repeat(40)}` },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "project_role_forbidden");
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
