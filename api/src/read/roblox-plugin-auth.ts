import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  requireReadUser,
  type ReadUser,
} from "./auth.js";
import { ReadApiError } from "./http.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

type PairingRequestRow = {
  id: string;
  client_proof_hash: Buffer;
  roblox_user_id: string;
  studio_universe_id: string;
  studio_place_id: string;
  install_id: string;
  status: "pending" | "approved" | "consumed" | "expired";
  project_id: string | null;
  code_hash: Buffer | null;
  attempt_count: number;
  expires_at: Date | string;
};

type EligibleProjectRow = {
  id: string;
  name: string;
  roblox_universe_id: string;
  icon_url: string | null;
  target_universe_id: string;
};

type PluginSessionRow = {
  credential_id: string;
  project_id: string;
  project_name: string;
  project_icon_url: string | null;
  source_universe_id: string;
  target_universe_id: string;
  studio_place_id: string;
  expires_at: Date | string;
};

const numericId = z.string().regex(/^[1-9]\d{0,19}$/);
const installId = z
  .string()
  .trim()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const browserToken = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const pairingRequestSchema = z.object({
  robloxUserId: numericId,
  studioUniverseId: numericId,
  studioPlaceId: numericId,
  installId,
});
const pairingParamsSchema = z.object({
  requestId: z.uuid(),
});
const browserPairingParamsSchema = z.object({
  browserToken,
});
const approvePairingSchema = z.object({
  projectId: z.uuid().optional(),
});
const verifyPairingSchema = z.object({
  clientProof: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  code: z.string().regex(/^\d{2}$/),
});

const PAIRING_SECONDS = 10 * 60;
const CREDENTIAL_SECONDS = 90 * 24 * 60 * 60;
const MAX_CODE_ATTEMPTS = 5;

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hashesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 32 ? token : null;
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
}

async function expireOldPairingRequests(
  queryable: Pool | PoolClient,
): Promise<void> {
  await queryable.query(
    `UPDATE roblox_plugin_pairing_requests
     SET status = 'expired', code_hash = NULL
     WHERE status IN ('pending', 'approved')
       AND expires_at <= now()`,
  );
}

async function loadPairingByBrowserToken(
  pool: Pool,
  token: string,
): Promise<PairingRequestRow> {
  await expireOldPairingRequests(pool);
  const result = await pool.query<PairingRequestRow>(
    `SELECT id, client_proof_hash, roblox_user_id, studio_universe_id,
            studio_place_id, install_id, status, project_id, code_hash,
            attempt_count, expires_at
     FROM roblox_plugin_pairing_requests
     WHERE browser_token_hash = $1`,
    [hash(token)],
  );
  const pairing = result.rows[0];
  if (!pairing) {
    throw new ReadApiError(
      404,
      "plugin_pairing_not_found",
      "This plugin connection request is invalid or has expired.",
    );
  }
  return pairing;
}

async function findEligibleProjects(
  queryable: Pool | PoolClient,
  userId: string,
  studioUniverseId: string,
): Promise<EligibleProjectRow[]> {
  const result = await queryable.query<EligibleProjectRow>(
    `SELECT DISTINCT
            p.id,
            p.name,
            p.roblox_universe_id,
            p.icon_url,
            $2::text AS target_universe_id
     FROM projects p
     JOIN project_memberships pm
       ON pm.project_id = p.id
      AND pm.user_id = $1
      AND pm.role IN ('owner', 'admin')
     LEFT JOIN roblox_place_oauth_grants grant_access
       ON grant_access.project_id = p.id
      AND grant_access.revoked_at IS NULL
      AND grant_access.target_universe_id = $2
     WHERE p.roblox_universe_id IS NOT NULL
       AND (
         p.roblox_universe_id = $2
         OR grant_access.id IS NOT NULL
       )
     ORDER BY p.name, p.id`,
    [userId, studioUniverseId],
  );
  return result.rows;
}

function requireMatchingRobloxAccount(
  user: ReadUser,
  pairing: PairingRequestRow,
): void {
  if (
    !user.robloxUserId ||
    user.robloxUserId !== pairing.roblox_user_id
  ) {
    throw new ReadApiError(
      403,
      "plugin_pairing_account_mismatch",
      "Sign in to Trace with the same Roblox account that is open in Studio.",
    );
  }
}

function mapProject(project: EligibleProjectRow) {
  return {
    id: project.id,
    name: project.name,
    robloxUniverseId: project.roblox_universe_id,
    iconUrl: project.icon_url,
    targetUniverseId: project.target_universe_id,
  };
}

function mapPluginSession(session: PluginSessionRow) {
  return {
    credentialId: session.credential_id,
    project: {
      id: session.project_id,
      name: session.project_name,
      iconUrl: session.project_icon_url,
      robloxUniverseId: session.source_universe_id,
    },
    targetUniverseId: session.target_universe_id,
    studioPlaceId: session.studio_place_id,
    expiresAt: new Date(session.expires_at).toISOString(),
  };
}

async function loadPluginSession(
  pool: Pool,
  request: FastifyRequest,
): Promise<PluginSessionRow> {
  const token = readBearerToken(request);
  if (!token) {
    throw new ReadApiError(
      401,
      "plugin_unauthenticated",
      "A Trace plugin credential is required.",
    );
  }
  const result = await pool.query<PluginSessionRow>(
    `UPDATE roblox_plugin_credentials credentials
     SET last_used_at = now()
     FROM projects project
     WHERE credentials.token_hash = $1
       AND credentials.project_id = project.id
       AND credentials.revoked_at IS NULL
       AND credentials.expires_at > now()
     RETURNING
       credentials.id AS credential_id,
       project.id AS project_id,
       project.name AS project_name,
       project.icon_url AS project_icon_url,
       credentials.source_universe_id,
       credentials.target_universe_id,
       credentials.studio_place_id,
       credentials.expires_at`,
    [hash(token)],
  );
  const session = result.rows[0];
  if (!session) {
    throw new ReadApiError(
      401,
      "plugin_credential_invalid",
      "This Trace plugin connection has expired or was revoked.",
    );
  }
  return session;
}

export async function registerRobloxPluginAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
  webOrigin: string,
): Promise<void> {
  app.post(
    "/v1/plugin-auth/requests",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
        },
      },
    },
    async (request, reply) => {
      const body = pairingRequestSchema.parse(request.body);
      await expireOldPairingRequests(pool);
      const requestId = randomUUID();
      const browserAccessToken = randomToken(32);
      const clientProof = randomToken(32);
      const result = await pool.query<{ id: string; expires_at: Date | string }>(
        `INSERT INTO roblox_plugin_pairing_requests (
           id, browser_token_hash, client_proof_hash, roblox_user_id,
           studio_universe_id, studio_place_id, install_id, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           now() + make_interval(secs => $8)
         )
         RETURNING id, expires_at`,
        [
          requestId,
          hash(browserAccessToken),
          hash(clientProof),
          body.robloxUserId,
          body.studioUniverseId,
          body.studioPlaceId,
          body.installId,
          PAIRING_SECONDS,
        ],
      );
      const browserUrl = new URL("/plugin-connect", webOrigin);
      browserUrl.searchParams.set("token", browserAccessToken);
      noStore(reply);
      return reply.code(201).send({
        requestId: result.rows[0]!.id,
        clientProof,
        browserUrl: browserUrl.toString(),
        expiresAt: new Date(result.rows[0]!.expires_at).toISOString(),
      });
    },
  );

  app.get(
    "/v1/manage/plugin-auth/:browserToken",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = requireReadUser(request);
      const { browserToken: token } = browserPairingParamsSchema.parse(
        request.params,
      );
      const pairing = await loadPairingByBrowserToken(pool, token);
      requireMatchingRobloxAccount(user, pairing);
      const projects = await findEligibleProjects(
        pool,
        user.id,
        pairing.studio_universe_id,
      );
      noStore(reply);
      return {
        request: {
          id: pairing.id,
          status: pairing.status,
          studioUniverseId: pairing.studio_universe_id,
          studioPlaceId: pairing.studio_place_id,
          expiresAt: new Date(pairing.expires_at).toISOString(),
          selectedProjectId: pairing.project_id,
        },
        projects: projects.map(mapProject),
      };
    },
  );

  app.post(
    "/v1/manage/plugin-auth/:browserToken/approve",
    {
      preHandler: authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
        },
      },
    },
    async (request, reply) => {
      const user = requireReadUser(request);
      const { browserToken: token } = browserPairingParamsSchema.parse(
        request.params,
      );
      const { projectId } = approvePairingSchema.parse(request.body ?? {});
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expireOldPairingRequests(client);
        const pairingResult = await client.query<PairingRequestRow>(
          `SELECT id, client_proof_hash, roblox_user_id, studio_universe_id,
                  studio_place_id, install_id, status, project_id, code_hash,
                  attempt_count, expires_at
           FROM roblox_plugin_pairing_requests
           WHERE browser_token_hash = $1
           FOR UPDATE`,
          [hash(token)],
        );
        const pairing = pairingResult.rows[0];
        if (!pairing) {
          throw new ReadApiError(
            404,
            "plugin_pairing_not_found",
            "This plugin connection request is invalid or has expired.",
          );
        }
        requireMatchingRobloxAccount(user, pairing);
        if (pairing.status === "expired") {
          throw new ReadApiError(
            410,
            "plugin_pairing_expired",
            "This plugin connection request has expired. Start again in Studio.",
          );
        }
        if (pairing.status === "consumed") {
          throw new ReadApiError(
            409,
            "plugin_pairing_consumed",
            "This Studio plugin is already connected.",
          );
        }

        const eligible = await findEligibleProjects(
          client,
          user.id,
          pairing.studio_universe_id,
        );
        const selected = projectId
          ? eligible.find((project) => project.id === projectId)
          : eligible.length === 1
            ? eligible[0]
            : null;
        if (!selected) {
          throw new ReadApiError(
            eligible.length === 0 ? 403 : 400,
            eligible.length === 0
              ? "plugin_pairing_project_forbidden"
              : "plugin_pairing_project_required",
            eligible.length === 0
              ? "No owner or admin Trace project is connected to this Studio experience."
              : "Choose which Trace project this Studio experience should use.",
          );
        }

        const code = String(randomInt(0, 100)).padStart(2, "0");
        await client.query(
          `UPDATE roblox_plugin_pairing_requests
           SET status = 'approved',
               project_id = $2,
               approved_by = $3,
               code_hash = $4,
               attempt_count = 0,
               approved_at = now()
           WHERE id = $1`,
          [pairing.id, selected.id, user.id, hash(`${pairing.id}:${code}`)],
        );
        await client.query("COMMIT");
        noStore(reply);
        return {
          code,
          expiresAt: new Date(pairing.expires_at).toISOString(),
          project: mapProject(selected),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/v1/plugin-auth/requests/:requestId/verify",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          hook: "preHandler",
        },
      },
    },
    async (request, reply) => {
      const { requestId } = pairingParamsSchema.parse(request.params);
      const body = verifyPairingSchema.parse(request.body);
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        await expireOldPairingRequests(client);
        const result = await client.query<PairingRequestRow>(
          `SELECT id, client_proof_hash, roblox_user_id, studio_universe_id,
                  studio_place_id, install_id, status, project_id, code_hash,
                  attempt_count, expires_at
           FROM roblox_plugin_pairing_requests
           WHERE id = $1
           FOR UPDATE`,
          [requestId],
        );
        const pairing = result.rows[0];
        if (
          !pairing ||
          !hashesMatch(pairing.client_proof_hash, hash(body.clientProof))
        ) {
          throw new ReadApiError(
            404,
            "plugin_pairing_not_found",
            "This plugin connection request is invalid or has expired.",
          );
        }
        if (pairing.status === "pending") {
          throw new ReadApiError(
            409,
            "plugin_pairing_not_approved",
            "Approve this connection on the Trace website first.",
          );
        }
        if (pairing.status === "expired") {
          throw new ReadApiError(
            410,
            "plugin_pairing_expired",
            "This plugin connection request has expired. Start again.",
          );
        }
        if (pairing.status === "consumed") {
          throw new ReadApiError(
            409,
            "plugin_pairing_consumed",
            "This connection code has already been used.",
          );
        }
        if (!pairing.project_id || !pairing.code_hash) {
          throw new ReadApiError(
            409,
            "plugin_pairing_not_approved",
            "Approve this connection on the Trace website first.",
          );
        }

        const submittedCodeHash = hash(`${pairing.id}:${body.code}`);
        if (!hashesMatch(pairing.code_hash, submittedCodeHash)) {
          const nextAttempt = Math.min(
            pairing.attempt_count + 1,
            MAX_CODE_ATTEMPTS,
          );
          await client.query(
            `UPDATE roblox_plugin_pairing_requests
             SET attempt_count = $2,
                 status = CASE WHEN $2 >= $3 THEN 'expired' ELSE status END,
                 code_hash = CASE WHEN $2 >= $3 THEN NULL ELSE code_hash END
             WHERE id = $1`,
            [pairing.id, nextAttempt, MAX_CODE_ATTEMPTS],
          );
          await client.query("COMMIT");
          committed = true;
          throw new ReadApiError(
            nextAttempt >= MAX_CODE_ATTEMPTS ? 410 : 401,
            nextAttempt >= MAX_CODE_ATTEMPTS
              ? "plugin_pairing_attempts_exhausted"
              : "plugin_pairing_code_invalid",
            nextAttempt >= MAX_CODE_ATTEMPTS
              ? "Too many incorrect codes. Start a new connection request."
              : "That code does not match the one shown on Trace.",
          );
        }

        const projectResult = await client.query<{
          id: string;
          name: string;
          icon_url: string | null;
          roblox_universe_id: string;
        }>(
          `SELECT id, name, icon_url, roblox_universe_id
           FROM projects
           WHERE id = $1 AND roblox_universe_id IS NOT NULL`,
          [pairing.project_id],
        );
        const project = projectResult.rows[0];
        if (!project) {
          throw new ReadApiError(
            409,
            "plugin_pairing_project_missing",
            "The connected Trace project is no longer available.",
          );
        }

        const credential = randomToken(32);
        await client.query(
          `UPDATE roblox_plugin_credentials credentials
           SET revoked_at = now()
           FROM roblox_plugin_pairing_requests pairing
           WHERE pairing.id = $1
             AND credentials.user_id = pairing.approved_by
             AND credentials.project_id = pairing.project_id
             AND credentials.install_id = pairing.install_id
             AND credentials.target_universe_id = pairing.studio_universe_id
             AND credentials.studio_place_id = pairing.studio_place_id
             AND credentials.revoked_at IS NULL`,
          [pairing.id],
        );
        const credentialResult = await client.query<{
          id: string;
          expires_at: Date | string;
        }>(
          `INSERT INTO roblox_plugin_credentials (
             token_hash, user_id, project_id, roblox_user_id, install_id,
             source_universe_id, target_universe_id, studio_place_id,
             expires_at
           )
           SELECT
             $1, approved_by, project_id, roblox_user_id, install_id,
             $2, studio_universe_id, studio_place_id,
             now() + make_interval(secs => $3)
           FROM roblox_plugin_pairing_requests
           WHERE id = $4
           RETURNING id, expires_at`,
          [
            hash(credential),
            project.roblox_universe_id,
            CREDENTIAL_SECONDS,
            pairing.id,
          ],
        );
        await client.query(
          `UPDATE roblox_plugin_pairing_requests
           SET status = 'consumed',
               code_hash = NULL,
               consumed_at = now()
           WHERE id = $1`,
          [pairing.id],
        );
        await client.query("COMMIT");
        committed = true;
        noStore(reply);
        return {
          token: credential,
          credentialId: credentialResult.rows[0]!.id,
          expiresAt: new Date(
            credentialResult.rows[0]!.expires_at,
          ).toISOString(),
          project: {
            id: project.id,
            name: project.name,
            iconUrl: project.icon_url,
            robloxUniverseId: project.roblox_universe_id,
          },
          targetUniverseId: pairing.studio_universe_id,
          studioPlaceId: pairing.studio_place_id,
        };
      } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get("/v1/plugin-auth/session", async (request, reply) => {
    const session = await loadPluginSession(pool, request);
    noStore(reply);
    return mapPluginSession(session);
  });

  app.post("/v1/plugin-auth/revoke", async (request, reply) => {
    const token = readBearerToken(request);
    if (token) {
      await pool.query(
        `UPDATE roblox_plugin_credentials
         SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hash(token)],
      );
    }
    noStore(reply);
    return reply.code(204).send();
  });
}
