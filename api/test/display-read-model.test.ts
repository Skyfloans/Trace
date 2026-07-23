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
  assert.match(script, /DISPLAY_BACKFILL_VALIDATE_ONLY/);
  assert.match(script, /validated: true, rolledBack: true/);
  assert.match(script, /display_error_group_members/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /DELETE FROM display_error_rollups_hourly/);
  assert.match(script, /exact_event_count/);
  assert.match(script, /display_event_count/);
  assert.match(script, /display_error_read_model_v1/);
  assert.ok(
    script.indexOf("Display read model verification failed")
      < script.indexOf("display_error_read_model_v1"),
  );
});
