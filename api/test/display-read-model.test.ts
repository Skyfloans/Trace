import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("display read model migration preserves exact groups and indexes fast reads", async () => {
  const sql = await readFile(
    new URL("../../database/migrations/012_display_error_read_model.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS display_error_groups/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS display_error_group_members/);
  assert.match(sql, /exact_group_id UUID PRIMARY KEY REFERENCES error_groups/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS display_error_rollups_hourly/);
  assert.match(sql, /display_error_groups_recent_idx/);
  assert.match(sql, /display_error_rollups_project_bucket_idx/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM error_groups/);
});

test("online backfill verifies totals before enabling display reads", async () => {
  const script = await readFile(
    new URL("../scripts/backfill-display-error-read-model.mjs", import.meta.url),
    "utf8",
  );

  assert.match(script, /Data loaded for player/);
  assert.match(script, /normalized_message ~\*/);
  assert.match(script, /\(\?<!\[A-Za-z0-9_\]\)/);
  assert.match(script, /IS DISTINCT FROM EXCLUDED\.display_group_id/);
  assert.match(script, /effective_fingerprint IS DISTINCT FROM display_fingerprint/);
  assert.match(script, /DISPLAY_BACKFILL_VALIDATE_ONLY/);
  assert.match(script, /validated: true, rolledBack: true/);
  assert.match(script, /display_error_group_members/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /CURSOR WITH HOLD/);
  assert.match(script, /expected_display_error_rollups/);
  assert.match(script, /bulkReconciledRollups/);
  assert.match(script, /display_group_id = target\.display_group_id/);
  assert.match(script, /DELETE FROM display_error_rollups_hourly/);
  assert.match(script, /exact_event_count/);
  assert.match(script, /display_event_count/);
  assert.match(script, /mismatched_rollups/);
  assert.match(script, /display_error_read_model_v1/);
  assert.ok(
    script.indexOf("Display read model verification failed")
      < script.indexOf("display_error_read_model_v1"),
  );
});

test("retention expires exact and display rollups atomically", async () => {
  const sql = await readFile(
    new URL("../../database/migrations/013_display_rollup_retention.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE OR REPLACE FUNCTION purge_expired_trace_data/);
  assert.match(sql, /DELETE FROM display_error_rollups_hourly/);
  assert.match(sql, /DELETE FROM occurrence_rollups_hourly/);
  assert.ok(
    sql.indexOf("DELETE FROM display_error_rollups_hourly")
      < sql.indexOf("DELETE FROM occurrence_rollups_hourly"),
  );
  assert.match(sql, /DELETE FROM display_error_groups/);
});

test("targeted reconciliation repairs under ingestion locks before readiness", async () => {
  const script = await readFile(
    new URL("../scripts/reconcile-display-error-read-model.mjs", import.meta.url),
    "utf8",
  );

  assert.match(script, /CURSOR WITH HOLD/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /DELETE FROM display_error_rollups_hourly/);
  assert.match(script, /mismatched_rollups/);
  assert.ok(
    script.indexOf("mismatched_rollups")
      < script.indexOf("display_error_read_model_v1"),
  );
});

test("rollup filters are backfilled and indexed before the fast path is enabled", async () => {
  const migration = await readFile(
    new URL("../../database/migrations/014_display_rollup_filters.sql", import.meta.url),
    "utf8",
  );
  const index = await readFile(
    new URL("../../database/migrations/015_display_rollup_filter_index.sql", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("../scripts/backfill-display-rollup-filters.mjs", import.meta.url),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS level log_level/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source log_source/);
  assert.match(index, /CREATE INDEX CONCURRENTLY/);
  assert.match(index, /display_error_rollups_filter_idx/);
  assert.match(script, /CURSOR WITH HOLD/);
  assert.match(script, /IS DISTINCT FROM ROW\(groups\.level, groups\.source\)/);
  assert.match(script, /display_error_rollups_filter_idx/);
  assert.ok(
    script.indexOf("mismatched_rollups")
      < script.indexOf("display_error_rollup_filters_v1"),
  );
});

test("display error impacts preserve exact data and bound distinct-count work", async () => {
  const migration = await readFile(
    new URL("../../database/migrations/016_display_error_impacts.sql", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("../scripts/backfill-display-error-impacts.mjs", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS display_error_group_players/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS display_error_group_jobs/);
  assert.match(migration, /PRIMARY KEY \(project_id, display_group_id, player_id\)/);
  assert.match(migration, /PRIMARY KEY \(project_id, display_group_id, job_id\)/);
  assert.match(migration, /purge_expired_display_error_impacts/);
  assert.doesNotMatch(migration, /DELETE FROM occurrences|UPDATE occurrences/);

  assert.match(script, /DISPLAY_IMPACT_BATCH_HOURS/);
  assert.match(script, /DISPLAY_IMPACT_START_AT/);
  assert.match(script, /error\?\.code !== "40P01"/);
  assert.match(script, /ORDER BY[\s\S]+members\.display_group_id/);
  assert.match(script, /ON CONFLICT \(project_id, display_group_id, player_id\)/);
  assert.match(script, /ON CONFLICT \(project_id, display_group_id, job_id\)/);
  assert.match(script, /missing_players/);
  assert.match(script, /missing_jobs/);
  assert.ok(
    script.indexOf("Display impact verification failed")
      < script.indexOf("display_error_impacts_v1"),
  );
});
