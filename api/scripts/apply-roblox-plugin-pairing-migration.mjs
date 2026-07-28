import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const migration = await readFile(
  new URL("./migrations/026_roblox_plugin_pairing.sql", import.meta.url),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(migration);
  const verification = await client.query(`
    SELECT
      to_regclass('public.roblox_plugin_pairing_requests')
        IS NOT NULL AS requests_ready,
      to_regclass('public.roblox_plugin_credentials')
        IS NOT NULL AS credentials_ready,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'roblox_oauth_flows'
          AND column_name = 'return_path'
      ) AS oauth_return_ready
  `);
  const state = verification.rows[0];
  if (Object.values(state).some((value) => value !== true)) {
    throw new Error(
      `Roblox plugin-pairing migration verification failed: ${JSON.stringify(state)}`,
    );
  }
  console.log(JSON.stringify({ migration: "026_roblox_plugin_pairing", ready: true }));
} finally {
  await client.end();
}
