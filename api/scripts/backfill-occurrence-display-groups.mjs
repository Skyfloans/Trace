import pg from "pg";

const batchHours = Number(
  process.env.OCCURRENCE_DISPLAY_BATCH_HOURS ?? 1,
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

function assertPartitionName(value) {
  if (!/^occurrences_\d{4}_\d{2}_\d{2}$/.test(value)) {
    throw new Error(`Unexpected occurrence partition: ${value}`);
  }
  return value;
}

try {
  const partitions = await client.query(`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'occurrences'
      AND child.relname ~ '^occurrences_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    ORDER BY child.relname
  `);

  for (const row of partitions.rows) {
    const partition = assertPartitionName(String(row.partition_name));
    const index = `${partition}_project_display_group_time_idx`;
    const bounds = await client.query(`
      SELECT
        COUNT(*)::bigint AS retained_rows,
        GREATEST(
          date_trunc('hour', COALESCE(MIN(occurred_at), now())),
          date_trunc('hour', now() - interval '3 days')
        ) AS first_bucket,
        LEAST(
          date_trunc('hour', COALESCE(MAX(occurred_at), now())) + interval '1 hour',
          now()
        ) AS finished_at
      FROM ${partition}
      WHERE occurred_at >= now() - interval '3 days'
    `);
    const partitionDate = new Date(
      `${partition.slice("occurrences_".length).replaceAll("_", "-")}T00:00:00.000Z`,
    );
    const oldestRetainedDate = new Date();
    oldestRetainedDate.setUTCDate(oldestRetainedDate.getUTCDate() - 3);
    oldestRetainedDate.setUTCHours(0, 0, 0, 0);
    if (
      String(bounds.rows[0].retained_rows) === "0"
      && partitionDate < oldestRetainedDate
    ) {
      const indexState = await client.query(`
        SELECT pg_index.indisvalid AS valid
        FROM pg_index
        JOIN pg_class ON pg_class.oid = pg_index.indexrelid
        WHERE pg_class.relname = $1
      `, [index]);
      if (indexState.rows[0]?.valid === false) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
      }
      console.log(JSON.stringify({ partition, skipped: "outside_retention" }));
      continue;
    }
    let cursor = new Date(bounds.rows[0].first_bucket);
    const finishedAt = new Date(bounds.rows[0].finished_at);

    while (cursor < finishedAt) {
      const next = new Date(Math.min(
        cursor.getTime() + batchHours * 60 * 60 * 1_000,
        finishedAt.getTime(),
      ));
      const updated = await client.query(`
        UPDATE ${partition} occurrences
        SET display_group_id = members.display_group_id
        FROM display_error_group_members members
        WHERE occurrences.group_id = members.exact_group_id
          AND occurrences.display_group_id IS NULL
          AND occurrences.occurred_at >= $1
          AND occurrences.occurred_at < $2
      `, [cursor, next]);
      console.log(JSON.stringify({
        partition,
        from: cursor.toISOString(),
        to: next.toISOString(),
        updated: updated.rowCount ?? 0,
      }));
      cursor = next;
    }

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}
      ON ${partition} (
        project_id,
        display_group_id,
        occurred_at DESC,
        id DESC
      )
    `);
    const attached = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_inherits
        JOIN pg_class parent_index
          ON parent_index.oid = pg_inherits.inhparent
        JOIN pg_class child_index
          ON child_index.oid = pg_inherits.inhrelid
        WHERE parent_index.relname = 'occurrences_project_display_group_time_idx'
          AND child_index.relname = $1
      ) AS attached
    `, [index]);
    if (attached.rows[0]?.attached !== true) {
      await client.query(`
        ALTER INDEX occurrences_project_display_group_time_idx
        ATTACH PARTITION ${index}
      `);
    }
    await client.query(`ANALYZE ${partition}`);
  }

  const verification = await client.query(`
    SELECT COUNT(*)::bigint AS missing
    FROM occurrences
    WHERE occurred_at >= now() - interval '3 days'
      AND display_group_id IS NULL
  `);
  if (String(verification.rows[0].missing) !== "0") {
    throw new Error(
      `Occurrence display-group verification failed: ${JSON.stringify(verification.rows[0])}`,
    );
  }

  await client.query(`
    INSERT INTO trace_read_model_state (key)
    VALUES ('occurrence_display_group_index_v1')
    ON CONFLICT (key) DO UPDATE SET ready_at = now()
  `);
  console.log(JSON.stringify({ ready: true, ...verification.rows[0] }));
} finally {
  await client.end();
}
