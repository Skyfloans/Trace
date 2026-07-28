import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const sql = await readFile(
  new URL("./migrations/027_roblox_autofix.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query(sql);
  const result = await client.query(`
    SELECT
      to_regclass('public.roblox_autofix_runs') IS NOT NULL
      AND to_regclass('public.roblox_autofix_proposals') IS NOT NULL
      AND to_regclass('public.roblox_autofix_files') IS NOT NULL AS ready
  `);
  console.log(JSON.stringify({ migration: "027_roblox_autofix", ready: result.rows[0]?.ready === true }));
} finally {
  await client.end();
}
