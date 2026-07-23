import { readFile } from "node:fs/promises";
import pg from "pg";

const migration = await readFile(
  new URL(
    "../../database/migrations/021_ai_classification_trigger.sql",
    import.meta.url,
  ),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(migration);
  const definition = await client.query(`
    SELECT pg_get_functiondef(
      'enqueue_ai_classification()'::regprocedure
    ) AS source
  `);
  const source = String(definition.rows[0]?.source ?? "");
  if (
    !source.includes("IF TG_TABLE_NAME = 'display_error_groups' THEN")
    || !source.includes("ELSIF TG_TABLE_NAME = 'feedback' THEN")
  ) {
    throw new Error("AI classification trigger verification failed");
  }
  console.log(JSON.stringify({
    trigger_fixed: true,
    table_specific_branches: true,
  }));
} finally {
  await client.end();
}
