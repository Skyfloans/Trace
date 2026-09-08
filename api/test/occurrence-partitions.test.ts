import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { ensureOccurrencePartitions } from "../src/db.js";

function fakePool(missingDates: string[]): {
  pool: Pool;
  queries: Array<{ text: string; values?: unknown[] }>;
  connectCount: () => number;
} {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let connects = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("AS partition_date")) {
        return { rows: missingDates.map((partition_date) => ({ partition_date })) };
      }
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      connects += 1;
      return client;
    },
  } as unknown as Pool;
  return { pool, queries, connectCount: () => connects };
}

test("occurrence partition maintenance skips DDL for existing partitions", async () => {
  const { pool, queries } = fakePool([]);

  await ensureOccurrencePartitions(pool);

  assert.equal(queries.some(({ text }) => text.includes("CREATE TABLE")), false);
  assert.ok(queries.some(({ text }) => text.includes("pg_advisory_xact_lock")));
  assert.deepEqual(
    queries.find(({ text }) => text.includes("AS partition_date"))?.values,
    [3],
  );
});

test("occurrence partition maintenance creates only reported missing dates", async () => {
  const { pool, queries } = fakePool(["2026-09-08"]);

  await ensureOccurrencePartitions(pool);

  const ddl = queries.find(({ text }) => text.includes("CREATE TABLE"))?.text;
  assert.match(ddl ?? "", /CREATE TABLE IF NOT EXISTS occurrences_2026_09_08/);
  assert.match(ddl ?? "", /FROM \('2026-09-08 00:00:00\+00'\)/);
  assert.match(ddl ?? "", /TO \('2026-09-09 00:00:00\+00'\)/);
});

test("concurrent occurrence partition checks share one operation", async () => {
  const { pool, connectCount } = fakePool([]);

  await Promise.all([
    ensureOccurrencePartitions(pool),
    ensureOccurrencePartitions(pool),
    ensureOccurrencePartitions(pool),
  ]);

  assert.equal(connectCount(), 1);
});
