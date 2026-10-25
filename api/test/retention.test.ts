import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { retentionDeleteSteps, runRetention } from "../src/retention.js";

interface FakeOptions {
  lockAcquired?: boolean;
  partitions?: Array<{ partition_name: string; past_aggregate_window: boolean }>;
  failWhen?: (text: string) => boolean;
  deleteCounts?: Record<string, number[]>;
  onQuery?: (text: string) => void;
}

function fakePool({
  lockAcquired = true,
  partitions = [],
  failWhen = () => false,
  deleteCounts = {},
  onQuery = () => undefined,
}: FakeOptions = {}) {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      onQuery(text);
      if (failWhen(text)) throw new Error("canceling statement due to statement timeout");
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: lockAcquired }] };
      if (text.includes("FROM pg_inherits")) return { rows: partitions };
      if (text.includes("AS cutoff")) return { rows: [{ cutoff: new Date("2026-10-21T00:00:00Z") }] };
      const deleteMatch = /^\s*DELETE FROM (\w+)/.exec(text);
      if (deleteMatch) {
        const counts = deleteCounts[deleteMatch[1]!] ?? [];
        return { rows: [], rowCount: counts.shift() ?? 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries };
}

test("retention does nothing when another instance holds the lock", async () => {
  const { pool, queries } = fakePool({ lockAcquired: false });

  const summary = await runRetention(pool);

  assert.equal(summary.lockAcquired, false);
  assert.equal(queries.some((text) => text.includes("DROP TABLE")), false);
  assert.equal(queries.some((text) => text.includes("DELETE FROM")), false);
});

test("partitions past the aggregate window are dropped without a rollup rebuild", async () => {
  const { pool, queries } = fakePool({
    partitions: [
      { partition_name: "occurrences_2026_07_19", past_aggregate_window: true },
      { partition_name: "occurrences_2026_10_22", past_aggregate_window: false },
    ],
  });

  const summary = await runRetention(pool);

  assert.deepEqual(summary.droppedPartitions, [
    "occurrences_2026_07_19",
    "occurrences_2026_10_22",
  ]);
  const rollups = queries.filter((text) => text.includes("INSERT INTO occurrence_rollups_hourly"));
  assert.equal(rollups.length, 1);
  assert.match(rollups[0]!, /FROM occurrences_2026_10_22 o/);
});

test("a failed rollup keeps its partition and does not stop other work", async () => {
  const { pool } = fakePool({
    partitions: [
      { partition_name: "occurrences_2026_10_22", past_aggregate_window: false },
      { partition_name: "occurrences_2026_10_23", past_aggregate_window: false },
    ],
    failWhen: (text) => text.includes("FROM occurrences_2026_10_22 o"),
  });

  const summary = await runRetention(pool);

  assert.deepEqual(summary.droppedPartitions, ["occurrences_2026_10_23"]);
  assert.deepEqual(summary.failures.map(({ step }) => step), ["occurrences_2026_10_22"]);
  assert.equal(Object.keys(summary.deletedRows).length, retentionDeleteSteps.length);
});

test("partition names that do not match the expected pattern are never dropped", async () => {
  const { pool, queries } = fakePool({
    partitions: [{ partition_name: "occurrences_2026_07_19; DROP TABLE projects", past_aggregate_window: true }],
  });

  const summary = await runRetention(pool);

  assert.deepEqual(summary.droppedPartitions, []);
  assert.equal(queries.some((text) => text.includes("DROP TABLE")), false);
});

test("deletes repeat full batches and a failing table does not block the next", async () => {
  const { pool } = fakePool({
    deleteCounts: { sessions: [3, 3, 1] },
    failWhen: (text) => /^\s*DELETE FROM occurrence_rollups_hourly/.test(text),
  });

  const summary = await runRetention(pool, { batchSize: 3 });

  assert.equal(summary.deletedRows.sessions, 7);
  assert.equal(summary.deletedRows.jobs, 0);
  assert.deepEqual(summary.failures.map(({ step }) => step), ["occurrence_rollups_hourly"]);
});

test("each table stops at its own time budget", async () => {
  let clock = 0;
  const { pool } = fakePool({ deleteCounts: { display_error_rollups_hourly: [5, 5, 5, 5, 5] } });

  const summary = await runRetention(pool, {
    batchSize: 5,
    stepBudgetMs: 2,
    now: () => clock++,
  });

  assert.ok((summary.deletedRows.display_error_rollups_hourly ?? 0) < 25);
  assert.equal(Object.keys(summary.deletedRows).length, retentionDeleteSteps.length);
});

test("slow partition rollups do not consume the delete budget", async () => {
  let clock = 0;
  const { pool } = fakePool({
    partitions: [{ partition_name: "occurrences_2026_10_22", past_aggregate_window: false }],
    deleteCounts: { sessions: [2, 1] },
    onQuery: (text) => {
      if (text.includes("INSERT INTO occurrence_rollups_hourly")) clock += 1_000_000;
    },
  });

  const summary = await runRetention(pool, {
    batchSize: 2,
    timeBudgetMs: 500,
    stepBudgetMs: 100,
    now: () => clock,
  });

  assert.deepEqual(summary.droppedPartitions, ["occurrences_2026_10_22"]);
  assert.equal(summary.deletedRows.sessions, 3);
  assert.equal(summary.budgetExhausted, false);
});
