import { readFile } from "node:fs/promises";
import pg from "pg";

const migration019 = await readFile(
  new URL("../../database/migrations/019_ai_classification.sql", import.meta.url),
  "utf8",
);
const migration020 = await readFile(
  new URL("../../database/migrations/020_ai_classification_indexes.sql", import.meta.url),
  "utf8",
);
const migration021 = await readFile(
  new URL("../../database/migrations/021_ai_classification_trigger.sql", import.meta.url),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const validateOnly = process.argv.includes("--validate-only");

try {
  if (validateOnly) {
    throw new Error(
      "Validation-only mode is unavailable for the split online migration",
    );
  } else {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(migration019);
      break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = error?.code;
      if (!["40P01", "55P03", "57014"].includes(code) || attempt >= 6) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  for (const statement of migration020
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
  await client.query(migration021);
  const verification = await client.query(`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'display_error_groups'
          AND column_name = 'ai_category'
      ) AS error_columns_ready,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'feedback'
          AND column_name = 'ai_category'
      ) AS feedback_columns_ready,
      to_regclass('public.display_error_groups_ai_category_recent_idx')
        IS NOT NULL AS error_index_ready,
      to_regclass('public.display_error_rollups_ai_filter_idx')
        IS NOT NULL AS rollup_index_ready,
      to_regclass('public.feedback_project_ai_category_time_idx')
        IS NOT NULL AS feedback_index_ready
  `);
  const state = verification.rows[0];
  if (Object.values(state).some((value) => value !== true)) {
    throw new Error(`AI migration verification failed: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ ready: true, ...state }));
  }
} finally {
  await client.end();
}
