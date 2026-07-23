import { readFile } from "node:fs/promises";
import pg from "pg";

const migration = await readFile(
  new URL(
    "../../database/migrations/022_ai_error_classification_cache.sql",
    import.meta.url,
  ),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(migration);
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      display_error_groups_global_fingerprint_idx
    ON display_error_groups (fingerprint, id)
  `);
  console.log(JSON.stringify({
    migration: "022_ai_error_classification_cache",
    applied: true,
  }));
} finally {
  await client.end();
}
