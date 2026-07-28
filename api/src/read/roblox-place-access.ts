import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ArchiveStorage } from "../archive-storage.js";
import { requireProjectRole } from "./auth.js";
import { ReadApiError } from "./http.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type RobloxPlaceOAuthConfig = {
  clientId: string;
  clientSecret: string;
  tokenEncryptionKey?: Buffer;
};

export type RobloxOAuthTokenSet = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

type GrantRow = {
  id: string;
  project_id: string;
  target_universe_id: string;
  root_place_id: string;
  access_token_ciphertext: Buffer;
  access_token_expires_at: Date | string;
  refresh_token_ciphertext: Buffer;
  revoked_at: Date | string | null;
};

const OAUTH_TOKEN_URL = "https://apis.roblox.com/oauth/v1/token";
const OAUTH_REVOKE_URL = "https://apis.roblox.com/oauth/v1/token/revoke";
const OPEN_CLOUD_BASE = "https://apis.roblox.com";
const MAX_PLACE_BYTES = 100 * 1_024 * 1_024;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const positiveRobloxId = /^[1-9]\d{0,19}$/;
const projectParamsSchema = z.object({ projectId: z.uuid() });

export const ROBLOX_PLACE_OAUTH_SCOPES = [
  "openid",
  "profile",
  "universe:read",
  "legacy-asset:manage",
] as const;

function encryptionKey(config: RobloxPlaceOAuthConfig): Buffer {
  if (!config.tokenEncryptionKey) {
    throw new ReadApiError(
      503,
      "roblox_place_access_not_configured",
      "Roblox place access is not configured on this server.",
    );
  }
  if (config.tokenEncryptionKey.byteLength !== 32) {
    throw new Error("ROBLOX_OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return config.tokenEncryptionKey;
}

export function encryptRobloxToken(
  token: string,
  key: Buffer,
  projectId: string,
): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`trace:roblox-place:${projectId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([1]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptRobloxToken(
  encrypted: Buffer,
  key: Buffer,
  projectId: string,
): string {
  if (encrypted.byteLength < 30 || encrypted[0] !== 1) {
    throw new Error("Unsupported encrypted Roblox token format");
  }
  const nonce = encrypted.subarray(1, 13);
  const tag = encrypted.subarray(13, 29);
  const ciphertext = encrypted.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`trace:roblox-place:${projectId}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

async function oauthTokenRequest(
  config: RobloxPlaceOAuthConfig,
  values: Record<string, string>,
): Promise<RobloxOAuthTokenSet> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...values,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ReadApiError(
      response.status === 400 || response.status === 401 ? 401 : 502,
      "roblox_place_authorization_expired",
      "Roblox place access has expired or was revoked. Reconnect the experience.",
    );
  }
  return (await response.json()) as RobloxOAuthTokenSet;
}

async function robloxBearerJson<T>(
  path: string,
  accessToken: string,
): Promise<T> {
  const response = await fetch(`${OPEN_CLOUD_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ReadApiError(
      response.status === 401 || response.status === 403 ? 403 : 502,
      "roblox_place_access_denied",
      "Roblox did not allow Trace to access that experience.",
    );
  }
  return (await response.json()) as T;
}

export async function resolveRootPlaceId(
  accessToken: string,
  universeId: string,
): Promise<string> {
  const universe = await robloxBearerJson<{
    rootPlace?: {
      id?: string | number;
      path?: string;
    } | string;
    rootPlaceId?: string | number;
  }>(
    `/cloud/v2/universes/${encodeURIComponent(universeId)}`,
    accessToken,
  );
  const rootPlacePath =
    typeof universe.rootPlace === "string"
      ? universe.rootPlace
      : universe.rootPlace?.path;
  const pathPlaceId = rootPlacePath?.match(/\/places\/(\d+)$/)?.[1];
  let rootPlaceId = String(
    universe.rootPlaceId ??
      (typeof universe.rootPlace === "object"
        ? universe.rootPlace.id
        : undefined) ??
      pathPlaceId ??
      "",
  );
  if (!positiveRobloxId.test(rootPlaceId)) {
    const response = await fetch(
      `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    ).catch(() => null);
    const body = response?.ok
      ? await response.json() as {
          data?: Array<{
            id?: string | number;
            rootPlaceId?: string | number;
          }>;
        }
      : null;
    const game = body?.data?.find(
      (candidate) => String(candidate.id) === universeId,
    );
    rootPlaceId = String(game?.rootPlaceId ?? "");
  }
  if (!positiveRobloxId.test(rootPlaceId)) {
    const response = await fetch(
      `https://develop.roblox.com/v1/universes/multiget?ids=${encodeURIComponent(universeId)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    ).catch(() => null);
    const body = response?.ok
      ? await response.json() as {
          data?: Array<{
            id?: string | number;
            rootPlaceId?: string | number;
          }>;
        }
      : null;
    const universeMetadata = body?.data?.find(
      (candidate) => String(candidate.id) === universeId,
    );
    rootPlaceId = String(universeMetadata?.rootPlaceId ?? "");
  }
  if (!positiveRobloxId.test(rootPlaceId)) {
    throw new ReadApiError(
      502,
      "roblox_root_place_missing",
      "Roblox did not return a root place for that experience.",
    );
  }
  return rootPlaceId;
}

function trustedRobloxCdnUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const trusted =
    hostname === "rbxcdn.com" ||
    hostname.endsWith(".rbxcdn.com") ||
    hostname === "roblox.com" ||
    hostname.endsWith(".roblox.com");
  if (url.protocol !== "https:" || !trusted || url.username || url.password) {
    throw new ReadApiError(
      502,
      "roblox_asset_location_invalid",
      "Roblox returned an invalid place download location.",
    );
  }
  return url;
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReadApiError(
      413,
      "roblox_place_too_large",
      "The Roblox place exceeds the 100 MB download limit.",
    );
  }
  if (!response.body) {
    throw new ReadApiError(
      502,
      "roblox_place_download_empty",
      "Roblox returned an empty place download.",
    );
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new ReadApiError(
        413,
        "roblox_place_too_large",
        "The Roblox place exceeds the 100 MB download limit.",
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new ReadApiError(
      502,
      "roblox_place_download_empty",
      "Roblox returned an empty place download.",
    );
  }
  return Buffer.concat(chunks, bytes);
}

export async function downloadCurrentPlace(
  accessToken: string,
  placeId: string,
): Promise<Buffer> {
  const delivery = await robloxBearerJson<{ location?: string }>(
    `/asset-delivery-api/v1/assetId/${encodeURIComponent(placeId)}`,
    accessToken,
  );
  if (!delivery.location) {
    throw new ReadApiError(
      502,
      "roblox_asset_location_missing",
      "Roblox did not return a place download location.",
    );
  }
  const location = trustedRobloxCdnUrl(delivery.location);
  const response = await fetch(location, {
    headers: { Accept: "application/octet-stream", "Accept-Encoding": "gzip" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new ReadApiError(
      502,
      "roblox_place_download_failed",
      "Roblox could not provide the current place file.",
    );
  }
  return readBodyWithLimit(response, MAX_PLACE_BYTES);
}

export async function saveRobloxPlaceGrant(
  pool: Pool,
  config: RobloxPlaceOAuthConfig,
  values: {
    accessToken: string;
    accessTokenExpiresIn: number;
    projectId: string;
    refreshToken: string;
    robloxUserId: string;
    rootPlaceId: string;
    scopes: string[];
    targetUniverseId: string;
    userId: string;
  },
): Promise<void> {
  const key = encryptionKey(config);
  const accessToken = encryptRobloxToken(
    values.accessToken,
    key,
    values.projectId,
  );
  const refreshToken = encryptRobloxToken(
    values.refreshToken,
    key,
    values.projectId,
  );
  const expiresIn = Math.max(60, Math.min(values.accessTokenExpiresIn, 3_600));
  await pool.query(
    `INSERT INTO roblox_place_oauth_grants (
       project_id, authorized_by, roblox_user_id, target_universe_id,
       root_place_id, scopes, access_token_ciphertext,
       access_token_expires_at, refresh_token_ciphertext
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       now() + ($8 * INTERVAL '1 second'), $9
     )
     ON CONFLICT (project_id) DO UPDATE
     SET authorized_by = EXCLUDED.authorized_by,
         roblox_user_id = EXCLUDED.roblox_user_id,
         target_universe_id = EXCLUDED.target_universe_id,
         root_place_id = EXCLUDED.root_place_id,
         scopes = EXCLUDED.scopes,
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         authorized_at = now(),
         refreshed_at = NULL,
         revoked_at = NULL,
         last_error_code = NULL,
         last_error_at = NULL`,
    [
      values.projectId,
      values.userId,
      values.robloxUserId,
      values.targetUniverseId,
      values.rootPlaceId,
      values.scopes,
      accessToken,
      expiresIn,
      refreshToken,
    ],
  );
}

async function lockGrant(
  client: PoolClient,
  projectId: string,
): Promise<GrantRow> {
  const result = await client.query<GrantRow>(
    `SELECT id, project_id, target_universe_id, root_place_id,
            access_token_ciphertext, access_token_expires_at,
            refresh_token_ciphertext, revoked_at
     FROM roblox_place_oauth_grants
     WHERE project_id = $1
     FOR UPDATE`,
    [projectId],
  );
  const grant = result.rows[0];
  if (!grant || grant.revoked_at) {
    throw new ReadApiError(
      409,
      "roblox_place_access_required",
      "Connect Roblox place access before requesting a snapshot.",
    );
  }
  return grant;
}

async function getGrantAccessToken(
  pool: Pool,
  config: RobloxPlaceOAuthConfig,
  projectId: string,
): Promise<{ accessToken: string; grant: GrantRow }> {
  const key = encryptionKey(config);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const grant = await lockGrant(client, projectId);
    const expiresAt = new Date(grant.access_token_expires_at).getTime();
    if (expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      const accessToken = decryptRobloxToken(
        grant.access_token_ciphertext,
        key,
        projectId,
      );
      await client.query("COMMIT");
      return { accessToken, grant };
    }

    const currentRefreshToken = decryptRobloxToken(
      grant.refresh_token_ciphertext,
      key,
      projectId,
    );
    let tokens: RobloxOAuthTokenSet;
    try {
      tokens = await oauthTokenRequest(config, {
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      });
    } catch (error) {
      await client.query(
        `UPDATE roblox_place_oauth_grants
         SET last_error_code = 'refresh_failed', last_error_at = now()
         WHERE id = $1`,
        [grant.id],
      );
      await client.query("COMMIT");
      throw error;
    }
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new ReadApiError(
        502,
        "roblox_token_response_invalid",
        "Roblox returned an invalid refreshed authorization.",
      );
    }
    const expiresIn = Math.max(
      60,
      Math.min(tokens.expires_in ?? 899, 3_600),
    );
    const encryptedAccessToken = encryptRobloxToken(
      tokens.access_token,
      key,
      projectId,
    );
    const encryptedRefreshToken = encryptRobloxToken(
      tokens.refresh_token,
      key,
      projectId,
    );
    await client.query(
      `UPDATE roblox_place_oauth_grants
       SET access_token_ciphertext = $2,
           access_token_expires_at = now() + ($3 * INTERVAL '1 second'),
           refresh_token_ciphertext = $4,
           refreshed_at = now(),
           last_error_code = NULL,
           last_error_at = NULL
       WHERE id = $1`,
      [grant.id, encryptedAccessToken, expiresIn, encryptedRefreshToken],
    );
    await client.query("COMMIT");
    return {
      accessToken: tokens.access_token,
      grant: {
        ...grant,
        access_token_ciphertext: encryptedAccessToken,
        access_token_expires_at: new Date(Date.now() + expiresIn * 1_000),
        refresh_token_ciphertext: encryptedRefreshToken,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function revokeGrant(
  pool: Pool,
  config: RobloxPlaceOAuthConfig,
  projectId: string,
): Promise<void> {
  const key = encryptionKey(config);
  const result = await pool.query<{
    id: string;
    refresh_token_ciphertext: Buffer;
  }>(
    `UPDATE roblox_place_oauth_grants
     SET revoked_at = now()
     WHERE project_id = $1 AND revoked_at IS NULL
     RETURNING id, refresh_token_ciphertext`,
    [projectId],
  );
  const grant = result.rows[0];
  if (!grant) return;

  const refreshToken = decryptRobloxToken(
    grant.refresh_token_ciphertext,
    key,
    projectId,
  );
  await fetch(OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token: refreshToken,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

export async function registerRobloxPlaceAccessRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
  oauth: RobloxPlaceOAuthConfig | null,
  storage: ArchiveStorage | null,
): Promise<void> {
  app.get(
    "/v1/manage/projects/:projectId/roblox-place-access",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner", "admin"]);
      const result = await pool.query(
        `SELECT target_universe_id, root_place_id, scopes, authorized_at,
                refreshed_at, revoked_at, last_error_code, last_error_at
         FROM roblox_place_oauth_grants
         WHERE project_id = $1`,
        [projectId],
      );
      const grant = result.rows[0];
      const snapshot = await pool.query(
        `SELECT id, target_universe_id, place_id, byte_size, sha256, created_at
         FROM roblox_place_snapshots
         WHERE project_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [projectId],
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        configured: Boolean(oauth?.tokenEncryptionKey && storage),
        connected: Boolean(grant && !grant.revoked_at),
        grant: grant
          ? {
              targetUniverseId: grant.target_universe_id,
              rootPlaceId: grant.root_place_id,
              scopes: grant.scopes,
              authorizedAt: new Date(grant.authorized_at).toISOString(),
              refreshedAt: grant.refreshed_at
                ? new Date(grant.refreshed_at).toISOString()
                : null,
              revokedAt: grant.revoked_at
                ? new Date(grant.revoked_at).toISOString()
                : null,
              lastErrorCode: grant.last_error_code,
              lastErrorAt: grant.last_error_at
                ? new Date(grant.last_error_at).toISOString()
                : null,
            }
          : null,
        latestSnapshot: snapshot.rows[0]
          ? {
              id: snapshot.rows[0].id,
              targetUniverseId: snapshot.rows[0].target_universe_id,
              placeId: snapshot.rows[0].place_id,
              bytes: Number(snapshot.rows[0].byte_size),
              sha256: snapshot.rows[0].sha256,
              createdAt: new Date(snapshot.rows[0].created_at).toISOString(),
            }
          : null,
      };
    },
  );

  app.post(
    "/v1/manage/projects/:projectId/roblox-place-snapshots",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner", "admin"]);
      if (!oauth) {
        throw new ReadApiError(
          503,
          "oauth_not_configured",
          "Roblox OAuth is not configured on this server.",
        );
      }
      if (!storage) {
        throw new ReadApiError(
          503,
          "place_storage_not_configured",
          "Object storage is required before Trace can snapshot a Roblox place.",
        );
      }

      const { accessToken, grant } = await getGrantAccessToken(
        pool,
        oauth,
        projectId,
      );
      const body = await downloadCurrentPlace(
        accessToken,
        grant.root_place_id,
      );
      const snapshotId = randomUUID();
      const objectKey = storage.key(
        `roblox-places/${projectId}/${snapshotId}.rbxl`,
      );
      const stored = await storage.putVerified(objectKey, body, {
        contentType: "application/octet-stream",
      });
      try {
        await pool.query(
          `INSERT INTO roblox_place_snapshots (
             id, project_id, grant_id, target_universe_id, place_id,
             object_key, byte_size, sha256
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            snapshotId,
            projectId,
            grant.id,
            grant.target_universe_id,
            grant.root_place_id,
            stored.objectKey,
            stored.bytes,
            stored.sha256,
          ],
        );
      } catch (error) {
        await storage.delete(stored.objectKey).catch(() => undefined);
        throw error;
      }
      return reply.code(201).send({
        id: snapshotId,
        targetUniverseId: grant.target_universe_id,
        placeId: grant.root_place_id,
        bytes: stored.bytes,
        sha256: stored.sha256,
      });
    },
  );

  app.delete(
    "/v1/manage/projects/:projectId/roblox-place-access",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner", "admin"]);
      if (!oauth) {
        throw new ReadApiError(
          503,
          "oauth_not_configured",
          "Roblox OAuth is not configured on this server.",
        );
      }
      await revokeGrant(pool, oauth, projectId);
      return reply.code(204).send();
    },
  );
}
