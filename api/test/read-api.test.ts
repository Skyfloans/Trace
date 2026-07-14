import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
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
