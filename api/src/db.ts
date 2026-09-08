import { Pool, type PoolClient } from "pg";

const occurrencePartitionEnsures = new WeakMap<Pool, Promise<void>>();

export function createPool(connectionString: string, maxConnections = 20): Pool {
  return new Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 5 * 60_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function nextUtcDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid occurrence partition date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid occurrence partition date: ${value}`);
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function createMissingOccurrencePartitions(
  pool: Pool,
  daysAhead: number,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('trace-occurrence-partitions', 0))",
    );
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const missing = await client.query<{ partition_date: string }>(
      `SELECT partition_date::date::text AS partition_date
       FROM generate_series(
         (now() AT TIME ZONE 'UTC')::date - 3,
         (now() AT TIME ZONE 'UTC')::date + $1::int,
         INTERVAL '1 day'
       ) AS dates(partition_date)
       WHERE to_regclass(
         format(
           '%I.%I',
           current_schema(),
           'occurrences_' || to_char(partition_date, 'YYYY_MM_DD')
         )
       ) IS NULL
       ORDER BY partition_date`,
      [daysAhead],
    );

    for (const row of missing.rows) {
      const rangeStart = row.partition_date;
      const rangeEnd = nextUtcDate(rangeStart);
      const partitionName = `occurrences_${rangeStart.replaceAll("-", "_")}`;
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${partitionName}
         PARTITION OF occurrences
         FOR VALUES FROM ('${rangeStart} 00:00:00+00')
                    TO ('${rangeEnd} 00:00:00+00')`,
      );
    }
  });
}

export function ensureOccurrencePartitions(
  pool: Pool,
  daysAhead = 3,
): Promise<void> {
  if (!Number.isInteger(daysAhead) || daysAhead < 0) {
    return Promise.reject(new Error("daysAhead must be a non-negative integer"));
  }

  const pending = occurrencePartitionEnsures.get(pool);
  if (pending) return pending;

  const operation = createMissingOccurrencePartitions(pool, daysAhead).finally(() => {
    if (occurrencePartitionEnsures.get(pool) === operation) {
      occurrencePartitionEnsures.delete(pool);
    }
  });
  occurrencePartitionEnsures.set(pool, operation);
  return operation;
}
