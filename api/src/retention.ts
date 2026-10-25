import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";

// Retention used to run as one purge_expired_trace_data() transaction with a
// 15s statement timeout. Recomputing rollups for a multi-GB partition never fit
// in that budget, so every run rolled back and nothing was ever removed. Each
// step below commits on its own so one slow table cannot block the rest.

const PARTITION_NAME = /^occurrences_\d{4}_\d{2}_\d{2}$/;

interface RetentionLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface RetentionOptions {
  rawRetention?: string;
  aggregateRetention?: string;
  batchSize?: number;
  timeBudgetMs?: number;
  stepBudgetMs?: number;
  now?: () => number;
  log?: RetentionLogger;
}

export interface RetentionSummary {
  lockAcquired: boolean;
  droppedPartitions: string[];
  deletedRows: Record<string, number>;
  failures: Array<{ step: string; message: string }>;
  budgetExhausted: boolean;
}

interface DeleteStep {
  table: string;
  condition: string;
}

// Children are purged before parents so foreign keys never block a batch.
export const retentionDeleteSteps: readonly DeleteStep[] = [
  { table: "display_error_rollups_hourly", condition: "bucket_at < $1" },
  { table: "occurrence_rollups_hourly", condition: "bucket_at < $1" },
  { table: "display_error_variants_hourly", condition: "bucket_at < $1" },
  { table: "display_error_group_players", condition: "last_seen_at < $1" },
  { table: "display_error_group_jobs", condition: "last_seen_at < $1" },
  {
    table: "sessions",
    condition: `COALESCE(sessions.ended_at, sessions.last_seen_at) < $1
      AND NOT EXISTS (
        SELECT 1 FROM occurrences WHERE occurrences.session_id = sessions.id
      )`,
  },
  {
    table: "error_groups",
    condition: `error_groups.last_seen_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM occurrences WHERE occurrences.group_id = error_groups.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM occurrence_rollups_hourly
        WHERE occurrence_rollups_hourly.group_id = error_groups.id
      )`,
  },
  {
    table: "display_error_groups",
    condition: `display_error_groups.last_seen_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM display_error_group_members members
        WHERE members.display_group_id = display_error_groups.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM display_error_rollups_hourly rollups
        WHERE rollups.project_id = display_error_groups.project_id
          AND rollups.display_group_id = display_error_groups.id
      )`,
  },
  {
    table: "jobs",
    condition: `COALESCE(jobs.ended_at, jobs.last_seen_at) < $1
      AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.job_id = jobs.id)
      AND NOT EXISTS (SELECT 1 FROM occurrences WHERE occurrences.job_id = jobs.id)`,
  },
];

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function expiredPartitions(
  client: PoolClient,
  rawRetention: string,
  aggregateRetention: string,
): Promise<Array<{ name: string; pastAggregateWindow: boolean }>> {
  const result = await client.query<{
    partition_name: string;
    past_aggregate_window: boolean;
  }>(
    `SELECT child.relname AS partition_name,
            (to_date(substring(child.relname FROM 13), 'YYYY_MM_DD') + 1)::timestamp
              AT TIME ZONE 'UTC' <= now() - $2::interval AS past_aggregate_window
     FROM pg_inherits
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.relname = 'occurrences'
       AND child.relname ~ '^occurrences_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
       AND to_date(substring(child.relname FROM 13), 'YYYY_MM_DD') + 1
           <= ((now() - $1::interval) AT TIME ZONE 'UTC')::date
     ORDER BY child.relname`,
    [rawRetention, aggregateRetention],
  );
  return result.rows
    .filter((row) => PARTITION_NAME.test(row.partition_name))
    .map((row) => ({
      name: row.partition_name,
      pastAggregateWindow: row.past_aggregate_window,
    }));
}

// Ingestion keeps hourly rollups current, but its player and server counts are
// running maxima. Recompute exact counts while the hours are still readable.
// Partitions past the aggregate window skip this: their rollups expire anyway.
async function rollUpPartition(pool: Pool, partition: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL statement_timeout = '10min'");
    await client.query(
      `INSERT INTO occurrence_rollups_hourly (
         project_id, group_id, bucket_at, event_count,
         affected_player_count, affected_server_count,
         first_seen_at, last_seen_at
       )
       SELECT
         o.project_id,
         o.group_id,
         date_trunc('hour', o.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
         SUM(o.repeat_count)::bigint,
         COUNT(DISTINCT s.player_id)::int,
         COUNT(DISTINCT o.job_id)::int,
         MIN(o.occurred_at),
         MAX(COALESCE(o.last_occurred_at, o.occurred_at))
       FROM ${partition} o
       LEFT JOIN sessions s ON s.id = o.session_id
       GROUP BY o.project_id, o.group_id, 3
       ON CONFLICT (project_id, group_id, bucket_at) DO UPDATE
       SET event_count = EXCLUDED.event_count,
           affected_player_count = EXCLUDED.affected_player_count,
           affected_server_count = EXCLUDED.affected_server_count,
           first_seen_at = EXCLUDED.first_seen_at,
           last_seen_at = EXCLUDED.last_seen_at`,
    );
  });
}

// DROP needs ACCESS EXCLUSIVE on the parent table. A short lock_timeout keeps
// ingestion from queueing behind it; a skipped partition is retried next run.
async function dropPartition(pool: Pool, partition: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(`DROP TABLE IF EXISTS ${partition}`);
  });
}

async function deleteBatch(
  pool: Pool,
  step: DeleteStep,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await client.query(
      `DELETE FROM ${step.table}
       WHERE ctid = ANY(ARRAY(
         SELECT ctid FROM ${step.table}
         WHERE ${step.condition}
         LIMIT $2
       ))`,
      [cutoff, batchSize],
    );
    return result.rowCount ?? 0;
  });
}

export async function runRetention(
  pool: Pool,
  {
    rawRetention = "24 hours",
    aggregateRetention = "3 days",
    batchSize = 10_000,
    timeBudgetMs = 10 * 60_000,
    stepBudgetMs = 60_000,
    now = Date.now,
    log,
  }: RetentionOptions = {},
): Promise<RetentionSummary> {
  const summary: RetentionSummary = {
    lockAcquired: false,
    droppedPartitions: [],
    deletedRows: {},
    failures: [],
    budgetExhausted: false,
  };
  const deadline = now() + timeBudgetMs;
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('trace-retention', 0)) AS acquired",
    );
    summary.lockAcquired = lock.rows[0]?.acquired === true;
    if (!summary.lockAcquired) return summary;

    try {
      const partitions = await expiredPartitions(
        lockClient,
        rawRetention,
        aggregateRetention,
      );
      for (const partition of partitions) {
        if (now() >= deadline) {
          summary.budgetExhausted = true;
          break;
        }
        try {
          if (!partition.pastAggregateWindow) {
            await rollUpPartition(pool, partition.name);
          }
          await dropPartition(pool, partition.name);
          summary.droppedPartitions.push(partition.name);
        } catch (error) {
          summary.failures.push({ step: partition.name, message: errorMessage(error) });
        }
      }
    } catch (error) {
      summary.failures.push({ step: "list partitions", message: errorMessage(error) });
    }

    const cutoffResult = await lockClient.query<{ cutoff: Date }>(
      "SELECT now() - $1::interval AS cutoff",
      [aggregateRetention],
    );
    const cutoff = cutoffResult.rows[0]!.cutoff;

    for (const step of retentionDeleteSteps) {
      let deleted = 0;
      // A per-table budget keeps a large backlog in one table from starving the rest.
      const stepDeadline = Math.min(deadline, now() + stepBudgetMs);
      try {
        while (now() < stepDeadline) {
          const count = await deleteBatch(pool, step, cutoff, batchSize);
          deleted += count;
          if (count < batchSize) break;
        }
      } catch (error) {
        summary.failures.push({ step: step.table, message: errorMessage(error) });
      }
      summary.deletedRows[step.table] = deleted;
      if (now() >= deadline) {
        summary.budgetExhausted = true;
        break;
      }
    }
  } finally {
    if (summary.lockAcquired) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtextextended('trace-retention', 0))")
        .catch(() => undefined);
    }
    lockClient.release();
  }

  if (summary.failures.length > 0) {
    log?.warn(summary, "retention completed with failures");
  } else {
    log?.info(summary, "retention completed");
  }
  return summary;
}
