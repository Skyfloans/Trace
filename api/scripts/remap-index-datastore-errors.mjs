import pg from "pg";

const validateOnly = process.env.INDEX_REMAP_VALIDATE_ONLY === "1";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

function assertPartitionName(value) {
  if (!/^occurrences_\d{4}_\d{2}_\d{2}$/.test(value)) {
    throw new Error(`Unexpected occurrence partition: ${value}`);
  }
  return value;
}

async function verifyRollups() {
  const result = await client.query(`
    WITH affected_groups AS (
      SELECT legacy_display_group_id AS display_group_id
      FROM index_remap_group_map
      UNION
      SELECT new_display_group_id
      FROM index_remap_group_map
    ), expected AS (
      SELECT
        rollups.project_id,
        targets.new_display_group_id AS display_group_id,
        rollups.bucket_at,
        SUM(rollups.event_count)::bigint AS event_count,
        MIN(rollups.first_seen_at) AS first_seen_at,
        MAX(rollups.last_seen_at) AS last_seen_at
      FROM occurrence_rollups_hourly rollups
      JOIN index_remap_targets targets
        ON targets.exact_group_id = rollups.group_id
      GROUP BY
        rollups.project_id,
        targets.new_display_group_id,
        rollups.bucket_at
    ), actual AS (
      SELECT
        rollups.project_id,
        rollups.display_group_id,
        rollups.bucket_at,
        rollups.event_count,
        rollups.first_seen_at,
        rollups.last_seen_at
      FROM display_error_rollups_hourly rollups
      JOIN affected_groups
        ON affected_groups.display_group_id = rollups.display_group_id
    )
    SELECT COUNT(*)::bigint AS mismatched
    FROM expected
    FULL JOIN actual USING (project_id, display_group_id, bucket_at)
    WHERE expected.project_id IS NULL
       OR actual.project_id IS NULL
       OR ROW(
         expected.event_count,
         expected.first_seen_at,
         expected.last_seen_at
       ) IS DISTINCT FROM ROW(
         actual.event_count,
         actual.first_seen_at,
         actual.last_seen_at
       )
  `);
  return Number(result.rows[0]?.mismatched ?? 0);
}

try {
  await client.query("SET statement_timeout = '0'");
  await client.query("SET lock_timeout = '5s'");
  await client.query(`
    CREATE TEMP TABLE index_remap_targets
    ON COMMIT PRESERVE ROWS
    AS
    WITH normalized AS (
      SELECT
        exact.id AS exact_group_id,
        exact.project_id,
        exact.source,
        exact.level,
        exact.first_seen_at,
        exact.last_seen_at,
        legacy.id AS legacy_display_group_id,
        regexp_replace(
          COALESCE(exact.display_message, exact.normalized_message),
          '(INDEX_)[0-9]{7,20}(?![A-Za-z0-9_])',
          '\\1<ID>',
          'gi'
        ) AS new_message,
        CASE
          WHEN COALESCE(
            exact.display_source_script,
            exact.source_script
          ) IS NULL THEN NULL
          ELSE regexp_replace(
            COALESCE(
              exact.display_source_script,
              exact.source_script
            ),
            '(INDEX_)[0-9]{7,20}(?![A-Za-z0-9_])',
            '\\1<ID>',
            'gi'
          )
        END AS new_source_script
      FROM error_groups exact
      JOIN display_error_groups legacy
        ON legacy.project_id = exact.project_id
       AND legacy.fingerprint = COALESCE(
         exact.display_fingerprint,
         exact.fingerprint
       )
      WHERE (
        COALESCE(exact.display_message, exact.normalized_message)
          ~* 'INDEX_[0-9]{7,20}([^A-Za-z0-9_]|$)'
        OR COALESCE(
          exact.display_source_script,
          exact.source_script,
          ''
        ) ~* 'INDEX_[0-9]{7,20}([^A-Za-z0-9_]|$)'
      )
    ), fingerprinted AS (
      SELECT
        normalized.*,
        encode(digest(
          convert_to(source::text, 'UTF8') || decode('00', 'hex') ||
          convert_to(level::text, 'UTF8') || decode('00', 'hex') ||
          convert_to(COALESCE(new_source_script, ''), 'UTF8') ||
            decode('00', 'hex') ||
          convert_to(new_message, 'UTF8'),
          'sha256'
        ), 'hex') AS new_fingerprint
      FROM normalized
    )
    SELECT
      fingerprinted.*,
      NULL::uuid AS new_display_group_id
    FROM fingerprinted
    JOIN display_error_groups legacy
      ON legacy.id = fingerprinted.legacy_display_group_id
    WHERE fingerprinted.new_fingerprint IS DISTINCT FROM legacy.fingerprint
  `);
  await client.query(`
    CREATE UNIQUE INDEX index_remap_targets_exact_idx
    ON index_remap_targets (exact_group_id)
  `);
  await client.query(`
    CREATE INDEX index_remap_targets_legacy_idx
    ON index_remap_targets (legacy_display_group_id)
  `);

  const shape = await client.query(`
    SELECT
      COUNT(*)::bigint AS exact_groups,
      COUNT(DISTINCT legacy_display_group_id)::bigint AS old_display_groups,
      COUNT(DISTINCT ROW(project_id, new_fingerprint))::bigint
        AS new_display_groups
    FROM index_remap_targets
  `);
  const partialLegacyGroups = await client.query(`
    SELECT COUNT(*)::bigint AS groups
    FROM (
      SELECT DISTINCT targets.legacy_display_group_id
      FROM index_remap_targets targets
      WHERE EXISTS (
        SELECT 1
        FROM display_error_group_members members
        WHERE members.display_group_id = targets.legacy_display_group_id
          AND NOT EXISTS (
            SELECT 1
            FROM index_remap_targets sibling
            WHERE sibling.exact_group_id = members.exact_group_id
          )
      )
    ) unsafe
  `);
  const summary = {
    ...shape.rows[0],
    partial_legacy_groups: partialLegacyGroups.rows[0]?.groups ?? "0",
  };
  console.log(JSON.stringify({ validateOnly, ...summary }));

  if (String(summary.partial_legacy_groups) !== "0") {
    throw new Error(
      `INDEX remap found mixed legacy groups: ${JSON.stringify(summary)}`,
    );
  }
  if (validateOnly || String(summary.exact_groups) === "0") {
    process.exitCode = 0;
  } else {
    await client.query("BEGIN");
    try {
      await client.query(`
        WITH grouped AS (
          SELECT
            project_id,
            new_fingerprint AS fingerprint,
            level,
            source,
            new_message AS normalized_message,
            new_source_script AS source_script,
            MIN(first_seen_at) AS first_seen_at,
            MAX(last_seen_at) AS last_seen_at
          FROM index_remap_targets
          GROUP BY
            project_id,
            new_fingerprint,
            level,
            source,
            new_message,
            new_source_script
        )
        INSERT INTO display_error_groups (
          project_id,
          fingerprint,
          level,
          source,
          normalized_message,
          source_script,
          first_seen_at,
          last_seen_at
        )
        SELECT
          project_id,
          fingerprint,
          level,
          source,
          normalized_message,
          source_script,
          first_seen_at,
          last_seen_at
        FROM grouped
        ORDER BY project_id, fingerprint
        ON CONFLICT (project_id, fingerprint) DO UPDATE
        SET first_seen_at = LEAST(
              display_error_groups.first_seen_at,
              EXCLUDED.first_seen_at
            ),
            last_seen_at = GREATEST(
              display_error_groups.last_seen_at,
              EXCLUDED.last_seen_at
            )
      `);
      await client.query(`
        UPDATE index_remap_targets targets
        SET new_display_group_id = groups.id
        FROM display_error_groups groups
        WHERE groups.project_id = targets.project_id
          AND groups.fingerprint = targets.new_fingerprint
      `);
      const unresolved = await client.query(`
        SELECT COUNT(*)::bigint AS groups
        FROM index_remap_targets
        WHERE new_display_group_id IS NULL
      `);
      if (String(unresolved.rows[0]?.groups) !== "0") {
        throw new Error(
          `INDEX remap failed to resolve groups: ${JSON.stringify(unresolved.rows[0])}`,
        );
      }
      await client.query(`
        CREATE TEMP TABLE index_remap_group_map
        ON COMMIT PRESERVE ROWS
        AS
        SELECT DISTINCT
          project_id,
          legacy_display_group_id,
          new_display_group_id
        FROM index_remap_targets
      `);
      await client.query(`
        CREATE UNIQUE INDEX index_remap_group_map_old_idx
        ON index_remap_group_map (legacy_display_group_id)
      `);

      await client.query(`
        UPDATE error_groups exact
        SET display_fingerprint = targets.new_fingerprint,
            display_message = targets.new_message,
            display_source_script = targets.new_source_script
        FROM index_remap_targets targets
        WHERE exact.id = targets.exact_group_id
      `);
      await client.query(`
        UPDATE display_error_group_members members
        SET display_group_id = targets.new_display_group_id
        FROM index_remap_targets targets
        WHERE members.exact_group_id = targets.exact_group_id
          AND members.display_group_id IS DISTINCT FROM
            targets.new_display_group_id
      `);

      await client.query(`
        INSERT INTO display_error_variants_hourly (
          project_id,
          display_group_id,
          bucket_at,
          message_hash,
          message,
          event_count,
          first_seen_at,
          last_seen_at
        )
        SELECT
          variants.project_id,
          mapping.new_display_group_id,
          variants.bucket_at,
          variants.message_hash,
          MAX(variants.message),
          SUM(variants.event_count)::bigint,
          MIN(variants.first_seen_at),
          MAX(variants.last_seen_at)
        FROM display_error_variants_hourly variants
        JOIN index_remap_group_map mapping
          ON mapping.legacy_display_group_id = variants.display_group_id
        WHERE mapping.legacy_display_group_id
          IS DISTINCT FROM mapping.new_display_group_id
        GROUP BY
          variants.project_id,
          mapping.new_display_group_id,
          variants.bucket_at,
          variants.message_hash
        ON CONFLICT (
          project_id,
          display_group_id,
          bucket_at,
          message_hash
        ) DO UPDATE
        SET event_count =
              display_error_variants_hourly.event_count +
              EXCLUDED.event_count,
            message = EXCLUDED.message,
            first_seen_at = LEAST(
              display_error_variants_hourly.first_seen_at,
              EXCLUDED.first_seen_at
            ),
            last_seen_at = GREATEST(
              display_error_variants_hourly.last_seen_at,
              EXCLUDED.last_seen_at
            )
      `);
      await client.query(`
        DELETE FROM display_error_variants_hourly variants
        USING index_remap_group_map mapping
        WHERE variants.display_group_id = mapping.legacy_display_group_id
          AND mapping.legacy_display_group_id
            IS DISTINCT FROM mapping.new_display_group_id
      `);

      await client.query(`
        INSERT INTO display_error_group_players (
          project_id,
          display_group_id,
          player_id,
          last_seen_at
        )
        SELECT
          players.project_id,
          mapping.new_display_group_id,
          players.player_id,
          MAX(players.last_seen_at)
        FROM display_error_group_players players
        JOIN index_remap_group_map mapping
          ON mapping.legacy_display_group_id = players.display_group_id
        WHERE mapping.legacy_display_group_id
          IS DISTINCT FROM mapping.new_display_group_id
        GROUP BY
          players.project_id,
          mapping.new_display_group_id,
          players.player_id
        ON CONFLICT (project_id, display_group_id, player_id) DO UPDATE
        SET last_seen_at = GREATEST(
          display_error_group_players.last_seen_at,
          EXCLUDED.last_seen_at
        )
      `);
      await client.query(`
        DELETE FROM display_error_group_players players
        USING index_remap_group_map mapping
        WHERE players.display_group_id = mapping.legacy_display_group_id
          AND mapping.legacy_display_group_id
            IS DISTINCT FROM mapping.new_display_group_id
      `);

      await client.query(`
        INSERT INTO display_error_group_jobs (
          project_id,
          display_group_id,
          job_id,
          last_seen_at
        )
        SELECT
          jobs.project_id,
          mapping.new_display_group_id,
          jobs.job_id,
          MAX(jobs.last_seen_at)
        FROM display_error_group_jobs jobs
        JOIN index_remap_group_map mapping
          ON mapping.legacy_display_group_id = jobs.display_group_id
        WHERE mapping.legacy_display_group_id
          IS DISTINCT FROM mapping.new_display_group_id
        GROUP BY
          jobs.project_id,
          mapping.new_display_group_id,
          jobs.job_id
        ON CONFLICT (project_id, display_group_id, job_id) DO UPDATE
        SET last_seen_at = GREATEST(
          display_error_group_jobs.last_seen_at,
          EXCLUDED.last_seen_at
        )
      `);
      await client.query(`
        DELETE FROM display_error_group_jobs jobs
        USING index_remap_group_map mapping
        WHERE jobs.display_group_id = mapping.legacy_display_group_id
          AND mapping.legacy_display_group_id
            IS DISTINCT FROM mapping.new_display_group_id
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const partitions = await client.query(`
      SELECT child.relname AS partition_name
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'occurrences'
        AND child.relname ~ '^occurrences_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
      ORDER BY child.relname
    `);
    let occurrenceUpdates = 0;
    for (const row of partitions.rows) {
      const partition = assertPartitionName(String(row.partition_name));
      const updated = await client.query(`
        UPDATE ${partition} occurrences
        SET display_group_id = targets.new_display_group_id
        FROM index_remap_targets targets
        WHERE occurrences.group_id = targets.exact_group_id
          AND occurrences.display_group_id IS DISTINCT FROM
            targets.new_display_group_id
      `);
      occurrenceUpdates += updated.rowCount ?? 0;
      if ((updated.rowCount ?? 0) > 0) {
        console.log(JSON.stringify({
          partition,
          occurrenceUpdates: updated.rowCount,
        }));
      }
    }

    let rollupMismatches = -1;
    for (let pass = 1; pass <= 3; pass += 1) {
      await client.query("BEGIN");
      try {
        await client.query(`
          SELECT rollups.project_id
          FROM occurrence_rollups_hourly rollups
          JOIN index_remap_targets targets
            ON targets.exact_group_id = rollups.group_id
          ORDER BY rollups.project_id, rollups.group_id, rollups.bucket_at
          FOR UPDATE OF rollups
        `);
        await client.query(`
          DELETE FROM display_error_rollups_hourly rollups
          USING (
            SELECT legacy_display_group_id AS display_group_id
            FROM index_remap_group_map
            UNION
            SELECT new_display_group_id
            FROM index_remap_group_map
          ) affected
          WHERE rollups.display_group_id = affected.display_group_id
        `);
        await client.query(`
          INSERT INTO display_error_rollups_hourly (
            project_id,
            display_group_id,
            bucket_at,
            event_count,
            first_seen_at,
            last_seen_at,
            level,
            source,
            ai_category
          )
          SELECT
            rollups.project_id,
            targets.new_display_group_id,
            rollups.bucket_at,
            SUM(rollups.event_count)::bigint,
            MIN(rollups.first_seen_at),
            MAX(rollups.last_seen_at),
            groups.level,
            groups.source,
            groups.ai_category
          FROM occurrence_rollups_hourly rollups
          JOIN index_remap_targets targets
            ON targets.exact_group_id = rollups.group_id
          JOIN display_error_groups groups
            ON groups.id = targets.new_display_group_id
          GROUP BY
            rollups.project_id,
            targets.new_display_group_id,
            rollups.bucket_at,
            groups.level,
            groups.source,
            groups.ai_category
        `);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      rollupMismatches = await verifyRollups();
      console.log(JSON.stringify({ pass, rollupMismatches }));
      if (rollupMismatches === 0) break;
    }
    if (rollupMismatches !== 0) {
      throw new Error(
        `INDEX remap rollup verification failed: ${rollupMismatches}`,
      );
    }

    await client.query("BEGIN");
    try {
      await client.query(`
        DELETE FROM ai_classification_jobs jobs
        USING index_remap_group_map mapping
        WHERE jobs.target_type = 'error'
          AND jobs.target_id = mapping.legacy_display_group_id
          AND mapping.legacy_display_group_id
            IS DISTINCT FROM mapping.new_display_group_id
      `);
      const removed = await client.query(`
        DELETE FROM display_error_groups groups
        USING index_remap_group_map mapping
        WHERE groups.id = mapping.legacy_display_group_id
          AND mapping.legacy_display_group_id
            IS DISTINCT FROM mapping.new_display_group_id
          AND NOT EXISTS (
            SELECT 1
            FROM display_error_group_members members
            WHERE members.display_group_id = groups.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM occurrences
            WHERE occurrences.display_group_id = groups.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM display_error_rollups_hourly rollups
            WHERE rollups.display_group_id = groups.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM display_error_variants_hourly variants
            WHERE variants.display_group_id = groups.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM display_error_group_players players
            WHERE players.display_group_id = groups.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM display_error_group_jobs jobs
            WHERE jobs.display_group_id = groups.id
          )
      `);
      await client.query("COMMIT");

      const verification = await client.query(`
        SELECT
          (SELECT COUNT(*)::bigint
           FROM display_error_group_members members
           JOIN index_remap_targets targets
             ON targets.exact_group_id = members.exact_group_id
           WHERE members.display_group_id IS DISTINCT FROM
             targets.new_display_group_id) AS member_mismatches,
          (SELECT COUNT(*)::bigint
           FROM occurrences
           JOIN index_remap_targets targets
             ON targets.exact_group_id = occurrences.group_id
           WHERE occurrences.display_group_id IS DISTINCT FROM
             targets.new_display_group_id) AS occurrence_mismatches,
          (SELECT COUNT(*)::bigint
           FROM display_error_groups groups
           JOIN index_remap_group_map mapping
             ON mapping.legacy_display_group_id = groups.id
           WHERE mapping.legacy_display_group_id
             IS DISTINCT FROM mapping.new_display_group_id) AS old_groups_remaining
      `);
      const state = verification.rows[0];
      if (
        String(state.member_mismatches) !== "0"
        || String(state.occurrence_mismatches) !== "0"
        || String(state.old_groups_remaining) !== "0"
      ) {
        throw new Error(
          `INDEX remap verification failed: ${JSON.stringify(state)}`,
        );
      }
      console.log(JSON.stringify({
        ready: true,
        occurrenceUpdates,
        rollupMismatches,
        removedOldDisplayGroups: removed.rowCount ?? 0,
        ...state,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} finally {
  await client.end();
}
