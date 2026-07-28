import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const migration = await readFile(
  new URL("./migrations/025_roblox_place_access.sql", import.meta.url),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(migration);
  const verification = await client.query(`
    SELECT
      to_regclass('public.roblox_place_oauth_grants')
        IS NOT NULL AS grants_ready,
      to_regclass('public.roblox_place_snapshots')
        IS NOT NULL AS snapshots_ready,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'roblox_oauth_flows'
          AND column_name = 'target_universe_id'
      ) AS oauth_target_ready
  `);
  const state = verification.rows[0];
  if (Object.values(state).some((value) => value !== true)) {
    throw new Error(
      `Roblox place-access migration verification failed: ${JSON.stringify(state)}`,
    );
  }
  console.log(JSON.stringify({ migration: "025_roblox_place_access", ready: true }));
} finally {
  await client.end();
}
