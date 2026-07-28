import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the API image packages the canonical Roblox place-access migration", async () => {
  const [canonical, packaged] = await Promise.all([
    readFile(
      new URL(
        "../../database/migrations/025_roblox_place_access.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../scripts/migrations/025_roblox_place_access.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.equal(packaged, canonical);
});
