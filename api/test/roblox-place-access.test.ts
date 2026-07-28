import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { ArchiveStorage } from "../src/archive-storage.js";
import { buildApp } from "../src/app.js";
import {
  decryptRobloxToken,
  downloadCurrentPlace,
  encryptRobloxToken,
  resolveRootPlaceId,
} from "../src/read/roblox-place-access.js";

const projectId = "20000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";

test("Roblox OAuth tokens are encrypted and bound to one Trace project", () => {
  const key = randomBytes(32);
  const plaintext = "refresh-token-that-must-not-be-stored-in-plaintext";
  const encrypted = encryptRobloxToken(plaintext, key, projectId);

  assert.equal(encrypted.includes(Buffer.from(plaintext)), false);
  assert.equal(
    decryptRobloxToken(encrypted, key, projectId),
    plaintext,
  );
  assert.throws(() =>
    decryptRobloxToken(
      encrypted,
      key,
      "20000000-0000-4000-8000-000000000002",
    ),
  );
});

test("root place resolution uses the authorized Open Cloud universe", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://apis.roblox.com/cloud/v2/universes/10587551620",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer access-token",
    );
    return Response.json({ rootPlaceId: 123456789 });
  };

  assert.equal(
    await resolveRootPlaceId("access-token", "10587551620"),
    "123456789",
  );
});

test("private test universe resolves through Roblox universe metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/cloud/v2/universes/")) {
      return Response.json({ path: "universes/10587551620" });
    }
    if (url.includes("games.roblox.com")) {
      return Response.json({
        data: [{ id: 0, rootPlaceId: 0, isContentRestricted: true }],
      });
    }
    if (url.includes("develop.roblox.com")) {
      return Response.json({
        data: [{
          id: 10587551620,
          name: "Trace test 2",
          privacyType: "Private",
          rootPlaceId: 72980619319007,
        }],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  assert.equal(
    await resolveRootPlaceId("access-token", "10587551620"),
    "72980619319007",
  );
});

test("place download does not forward OAuth credentials to Roblox CDN", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ authorization: string | null; url: string }> = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      authorization: new Headers(init?.headers).get("authorization"),
      url,
    });
    if (url.includes("/asset-delivery-api/")) {
      return Response.json({
        location: "https://c0.rbxcdn.com/current-place",
      });
    }
    return new Response(Buffer.from("rbxl-place-data"), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  };

  const place = await downloadCurrentPlace("access-token", "123456789");
  assert.equal(place.toString("utf8"), "rbxl-place-data");
  assert.deepEqual(calls, [
    {
      authorization: "Bearer access-token",
      url: "https://apis.roblox.com/asset-delivery-api/v1/assetId/123456789",
    },
    {
      authorization: null,
      url: "https://c0.rbxcdn.com/current-place",
    },
  ]);
});

test("place download rejects a non-Roblox asset location", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    Response.json({ location: "https://attacker.example/place.rbxl" });

  await assert.rejects(
    downloadCurrentPlace("access-token", "123456789"),
    (error: { code?: string }) =>
      error.code === "roblox_asset_location_invalid",
  );
});

test("place access OAuth requests the editable test universe and download scope", async () => {
  const insertedValues: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: userId,
            email: null,
            name: "Trace owner",
            robloxUserId: "190970206",
            robloxUsername: "skyfloans",
            robloxDisplayName: "Sky",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ role: "owner" }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM roblox_oauth_flows")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO roblox_oauth_flows")) {
        insertedValues.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp(pool, "http://localhost:5173", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:5173/api/v1/auth/roblox/callback",
    tokenEncryptionKey: randomBytes(32),
  });

  const response = await app.inject({
    method: "GET",
    url:
      `/v1/auth/roblox/start?intent=place_access&projectId=${projectId}` +
      "&targetUniverseId=10587551620",
    cookies: { trace_session: "s".repeat(40) },
  });

  assert.equal(response.statusCode, 302);
  const authorization = new URL(response.headers.location!);
  const scopes = authorization.searchParams.get("scope")?.split(" ") ?? [];
  assert.equal(scopes.includes("universe:read"), true);
  assert.equal(scopes.includes("legacy-asset:manage"), true);
  assert.equal(insertedValues[0]?.includes(projectId), true);
  assert.equal(insertedValues[0]?.includes("10587551620"), true);
  await app.close();
});

test("snapshot refreshes a rotated token and stores a verified RBXL", async (t) => {
  const originalFetch = globalThis.fetch;
  const key = randomBytes(32);
  const refreshedBodies: string[] = [];
  const insertedSnapshots: unknown[][] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/v1/token")) {
      refreshedBodies.push(String(init?.body));
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 899,
      });
    }
    if (url.includes("/asset-delivery-api/")) {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer new-access-token",
      );
      return Response.json({
        location: "https://c0.rbxcdn.com/current-place",
      });
    }
    if (url === "https://c0.rbxcdn.com/current-place") {
      return new Response(Buffer.from("verified-rbxl"));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const client = {
    query: async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM roblox_place_oauth_grants")) {
        return {
          rows: [{
            id: "30000000-0000-4000-8000-000000000001",
            project_id: projectId,
            target_universe_id: "10587551620",
            root_place_id: "123456789",
            access_token_ciphertext: encryptRobloxToken(
              "expired-access-token",
              key,
              projectId,
            ),
            access_token_expires_at: new Date(0),
            refresh_token_ciphertext: encryptRobloxToken(
              "current-refresh-token",
              key,
              projectId,
            ),
            revoked_at: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE roblox_place_oauth_grants")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM web_sessions")) {
        return {
          rows: [{
            id: userId,
            email: null,
            name: "Trace owner",
            robloxUserId: "190970206",
            robloxUsername: "skyfloans",
            robloxDisplayName: "Sky",
            robloxAvatarUrl: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM project_memberships")) {
        return { rows: [{ role: "owner" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO roblox_place_snapshots")) {
        insertedSnapshots.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const storage = {
    key: (keyValue: string) => `trace-telemetry/${keyValue}`,
    putVerified: async (objectKey: string, body: Buffer) => ({
      bytes: body.byteLength,
      objectKey,
      sha256: "8".repeat(64),
    }),
  } as unknown as ArchiveStorage;
  const app = await buildApp(
    pool,
    "http://localhost:5173",
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:5173/api/v1/auth/roblox/callback",
      tokenEncryptionKey: key,
    },
    pool,
    storage,
  );

  const response = await app.inject({
    method: "POST",
    url: `/v1/manage/projects/${projectId}/roblox-place-snapshots`,
    cookies: { trace_session: "s".repeat(40) },
  });

  assert.equal(response.statusCode, 201);
  assert.match(refreshedBodies[0]!, /refresh_token=current-refresh-token/);
  assert.equal(response.json().targetUniverseId, "10587551620");
  assert.equal(response.json().placeId, "123456789");
  assert.equal(insertedSnapshots.length, 1);
  await app.close();
});
