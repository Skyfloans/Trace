import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  findReadUserForRequest,
  invalidateProjectMembership,
  invalidateReadSession,
  requireProjectRole,
  requireReadUser,
} from "./auth.js";
import { ReadApiError } from "./http.js";
import { getGameMetadata } from "./roblox.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type RobloxOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webOrigin: string;
};

type OAuthFlow = {
  browser_binding_hash: Buffer;
  user_id: string | null;
  intent: "login" | "claim";
  universe_id: string | null;
  code_verifier: string;
};

type RobloxUserInfo = {
  sub: string;
  preferred_username?: string;
  name?: string;
  nickname?: string;
  picture?: string | null;
};

const OAUTH_BASE = "https://apis.roblox.com/oauth/v1";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ROBLOX_USER_CACHE_MS = 5 * 60 * 1_000;
const ROBLOX_USER_CACHE_LIMIT = 250;
const numericId = z.string().regex(/^\d{1,20}$/);
const robloxUsername = z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9_]+$/);
const startSchema = z.object({
  intent: z.enum(["login", "claim"]).default("login"),
  universeId: numericId.optional(),
});
const callbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(32).optional(),
  error: z.string().optional(),
});
const universeParamsSchema = z.object({ universeId: numericId });
const robloxUsernameParamsSchema = z.object({ username: robloxUsername });
const projectParamsSchema = z.object({ projectId: z.uuid() });
const memberParamsSchema = projectParamsSchema.extend({ userId: z.uuid() });
const invitationParamsSchema = projectParamsSchema.extend({ invitationId: z.uuid() });
const recipientInvitationParamsSchema = z.object({ invitationId: z.uuid() });
const inviteSchema = z.object({
  username: robloxUsername,
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

type RobloxUserPreview = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
};

const robloxUserCache = new Map<string, { expiresAt: number; value: RobloxUserPreview }>();

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function oauthErrorRedirect(config: RobloxOAuthConfig, code: string): string {
  const url = new URL(config.webOrigin);
  url.searchParams.set("oauthError", code);
  return url.toString();
}

async function robloxTokenRequest<T>(
  config: RobloxOAuthConfig,
  values: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${OAUTH_BASE}/token`, {
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
    throw new ReadApiError(502, "roblox_oauth_failed", "Roblox could not complete authentication.");
  }
  return (await response.json()) as T;
}

async function robloxFormRequest<T>(
  config: RobloxOAuthConfig,
  path: string,
  values: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${OAUTH_BASE}/${path}`, {
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
    throw new ReadApiError(502, "roblox_oauth_failed", "Roblox could not verify experience access.");
  }
  return (await response.json()) as T;
}

async function getRobloxUser(accessToken: string): Promise<RobloxUserInfo> {
  const response = await fetch(`${OAUTH_BASE}/userinfo`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ReadApiError(502, "roblox_profile_failed", "Roblox did not return an account profile.");
  }
  const user = (await response.json()) as RobloxUserInfo;
  if (!/^\d{1,20}$/.test(user.sub)) {
    throw new ReadApiError(502, "roblox_profile_invalid", "Roblox returned an invalid account profile.");
  }
  return user;
}

async function getRobloxAvatarUrl(robloxUserId: string): Promise<string | null> {
  const response = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(robloxUserId)}&size=150x150&format=Png&isCircular=false`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
  ).catch(() => null);
  if (!response?.ok) return null;

  const body = (await response.json().catch(() => null)) as {
    data?: Array<{ state?: string; imageUrl?: string }>;
  } | null;
  const avatar = body?.data?.[0];
  return avatar?.state === "Completed" ? avatar.imageUrl ?? null : null;
}

async function upsertRobloxUser(
  pool: Pool,
  existingUserId: string | null,
  profile: RobloxUserInfo,
): Promise<string> {
  const username = profile.preferred_username ?? profile.name ?? `Roblox ${profile.sub}`;
  const displayName = profile.nickname ?? profile.name ?? username;

  if (existingUserId) {
    const attached = await pool.query<{ id: string }>(
      `UPDATE users
       SET roblox_user_id = $2,
           roblox_username = $3,
           roblox_display_name = $4,
           roblox_avatar_url = COALESCE($5, roblox_avatar_url),
           name = COALESCE(name, $4),
           last_login_at = now()
       WHERE id = $1
         AND (roblox_user_id IS NULL OR roblox_user_id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM users other
           WHERE other.roblox_user_id = $2 AND other.id <> $1
         )
       RETURNING id`,
      [existingUserId, profile.sub, username, displayName, profile.picture ?? null],
    );
    if (attached.rows[0]) return attached.rows[0].id;
  }

  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (
       roblox_user_id, roblox_username, roblox_display_name,
       roblox_avatar_url, name, last_login_at
     )
     VALUES ($1, $2, $3, $4, $3, now())
     ON CONFLICT (roblox_user_id) WHERE roblox_user_id IS NOT NULL DO UPDATE
     SET roblox_username = EXCLUDED.roblox_username,
         roblox_display_name = EXCLUDED.roblox_display_name,
         roblox_avatar_url = COALESCE(
           EXCLUDED.roblox_avatar_url,
           users.roblox_avatar_url
         ),
         last_login_at = now()
     RETURNING id`,
    [profile.sub, username, displayName, profile.picture ?? null],
  );
  return result.rows[0]!.id;
}

async function createWebSession(pool: Pool, userId: string): Promise<string> {
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO web_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + INTERVAL '30 days')`,
    [userId, hash(token)],
  );
  return token;
}

function setSessionCookie(reply: FastifyReply, token: string, config: RobloxOAuthConfig): void {
  reply.setCookie("trace_session", token, {
    path: "/",
    httpOnly: true,
    secure: config.redirectUri.startsWith("https://"),
    sameSite: "lax",
    maxAge: SESSION_SECONDS,
  });
}

function cookieSecurity(config: RobloxOAuthConfig) {
  return {
    httpOnly: true,
    secure: config.redirectUri.startsWith("https://"),
    sameSite: "lax" as const,
  };
}

function oauthCallbackCookiePath(config: RobloxOAuthConfig): string {
  return new URL(config.redirectUri).pathname;
}

async function resolveRobloxUsername(username: string): Promise<RobloxUserPreview> {
  const cacheKey = username.toLowerCase();
  const cached = robloxUserCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new ReadApiError(502, "roblox_user_lookup_failed", "Roblox user lookup is temporarily unavailable.");
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: number; name?: string; displayName?: string }>;
  };
  const user = body.data?.[0];
  if (!user?.id || !user.name) {
    throw new ReadApiError(404, "roblox_user_not_found", "That Roblox username was not found.");
  }

  const avatarResponse = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(String(user.id))}&size=150x150&format=Png&isCircular=false`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
  ).catch(() => null);
  const avatarBody = avatarResponse?.ok
    ? await avatarResponse.json() as { data?: Array<{ state?: string; imageUrl?: string }> }
    : null;
  const avatar = avatarBody?.data?.[0];
  const value = {
    id: String(user.id),
    name: user.name,
    displayName: user.displayName ?? user.name,
    avatarUrl: avatar?.state === "Completed" ? avatar.imageUrl ?? null : null,
  };
  if (robloxUserCache.size >= ROBLOX_USER_CACHE_LIMIT) {
    const oldestKey = robloxUserCache.keys().next().value;
    if (oldestKey) robloxUserCache.delete(oldestKey);
  }
  robloxUserCache.set(cacheKey, { expiresAt: Date.now() + ROBLOX_USER_CACHE_MS, value });
  return value;
}

async function beginTransaction(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("BEGIN");
  return client;
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
  oauth: RobloxOAuthConfig | null,
): Promise<void> {
  app.get("/v1/auth/roblox/start", async (request, reply) => {
    if (!oauth) throw new ReadApiError(503, "oauth_not_configured", "Roblox sign-in is not configured yet.");
    const { intent, universeId } = startSchema.parse(request.query);
    const existingUser = await findReadUserForRequest(pool, request);
    if (intent === "claim" && (!existingUser || !universeId)) {
      throw new ReadApiError(401, "claim_sign_in_required", "Sign in before linking an experience.");
    }

    const state = randomToken(32);
    const browserBinding = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const nonce = randomToken(24);
    await pool.query("DELETE FROM roblox_oauth_flows WHERE expires_at <= now()");
    await pool.query(
      `INSERT INTO roblox_oauth_flows (
         state_hash, browser_binding_hash, user_id, intent, universe_id,
         code_verifier, nonce, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + INTERVAL '10 minutes')`,
      [hash(state), hash(browserBinding), intent === "claim" ? existingUser!.id : existingUser?.id ?? null, intent, universeId ?? null, verifier, nonce],
    );
    reply.setCookie("trace_oauth_binding", browserBinding, {
      path: oauthCallbackCookiePath(oauth),
      ...cookieSecurity(oauth),
      maxAge: 10 * 60,
    });

    const authorization = new URL(`${OAUTH_BASE}/authorize`);
    authorization.search = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      response_type: "code",
      scope: intent === "claim" ? "openid profile universe:read" : "openid profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return reply.redirect(authorization.toString());
  });

  app.get("/v1/auth/roblox/callback", async (request, reply) => {
    if (!oauth) throw new ReadApiError(503, "oauth_not_configured", "Roblox sign-in is not configured yet.");
    const query = callbackSchema.parse(request.query);
    if (query.error || !query.code || !query.state) {
      return reply.redirect(oauthErrorRedirect(oauth, query.error ?? "authorization_cancelled"));
    }

    const flowResult = await pool.query<OAuthFlow>(
      `DELETE FROM roblox_oauth_flows
       WHERE state_hash = $1 AND expires_at > now()
       RETURNING browser_binding_hash, user_id, intent, universe_id, code_verifier`,
      [hash(query.state)],
    );
    const flow = flowResult.rows[0];
    if (!flow) return reply.redirect(oauthErrorRedirect(oauth, "invalid_or_expired_state"));
    const browserBinding = request.cookies.trace_oauth_binding;
    reply.clearCookie("trace_oauth_binding", {
      path: oauthCallbackCookiePath(oauth),
    });
    const bindingHash = browserBinding ? hash(browserBinding) : null;
    if (
      !bindingHash ||
      bindingHash.length !== flow.browser_binding_hash.length ||
      !timingSafeEqual(bindingHash, flow.browser_binding_hash)
    ) {
      return reply.redirect(oauthErrorRedirect(oauth, "oauth_browser_mismatch"));
    }

    try {
      const tokens = await robloxTokenRequest<{
        access_token: string;
        refresh_token?: string;
      }>(oauth, {
        grant_type: "authorization_code",
        code: query.code,
        code_verifier: flow.code_verifier,
        redirect_uri: oauth.redirectUri,
      });
      const oauthProfile = await getRobloxUser(tokens.access_token);
      const profile = {
        ...oauthProfile,
        picture:
          oauthProfile.picture ??
          (await getRobloxAvatarUrl(oauthProfile.sub)),
      };
      const userId = await upsertRobloxUser(pool, flow.user_id, profile);

      if (flow.intent === "claim") {
        if (!flow.user_id || userId !== flow.user_id || !flow.universe_id) {
          throw new ReadApiError(403, "claim_account_mismatch", "Use the same Roblox account that is signed in to Trace.");
        }
        const resources = await robloxFormRequest<{
          resource_infos?: Array<{ resources?: { universe?: { ids?: Array<string | number> } } }>;
        }>(oauth, "token/resources", { token: tokens.access_token });
        const allowed = resources.resource_infos?.some((info) =>
          info.resources?.universe?.ids?.some((id) => String(id) === flow.universe_id),
        );
        if (!allowed) {
          throw new ReadApiError(403, "universe_not_authorized", "Roblox did not grant access to that experience.");
        }
        await pool.query(
          `INSERT INTO verified_universe_claims (user_id, universe_id, expires_at)
           VALUES ($1, $2, now() + INTERVAL '15 minutes')
           ON CONFLICT (user_id, universe_id) DO UPDATE
           SET verified_at = now(), expires_at = EXCLUDED.expires_at`,
          [userId, flow.universe_id],
        );
      }

      const sessionToken = await createWebSession(pool, userId);
      setSessionCookie(reply, sessionToken, oauth);
      if (tokens.refresh_token) {
        void robloxFormRequest(oauth, "token/revoke", { token: tokens.refresh_token }).catch(() => undefined);
      }
      const destination = new URL(oauth.webOrigin);
      if (flow.intent === "claim") {
        destination.searchParams.set("manage", "games");
        destination.searchParams.set("claim", "verified");
        destination.searchParams.set("universeId", flow.universe_id!);
      } else {
        destination.searchParams.set("signedIn", "true");
      }
      return reply.redirect(destination.toString());
    } catch (error) {
      request.log.warn({ error }, "Roblox OAuth callback failed");
      const code = error instanceof ReadApiError ? error.code : "oauth_callback_failed";
      return reply.redirect(oauthErrorRedirect(oauth, code));
    }
  });

  app.get("/v1/auth/me", { preHandler: authenticate }, async (request, reply) => {
    const user = requireReadUser(request);
    reply.header("Cache-Control", "private, no-store");
    return { user };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = request.cookies.trace_session;
    if (token) {
      await pool.query("UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1", [hash(token)]);
      invalidateReadSession(pool, token);
    }
    reply.clearCookie("trace_session", {
      path: "/",
      httpOnly: true,
      secure: oauth?.redirectUri.startsWith("https://") ?? true,
      sameSite: "lax",
    });
    return reply.code(204).send();
  });

  app.get("/v1/invitations", { preHandler: authenticate }, async (request, reply) => {
    const user = requireReadUser(request);
    reply.header("Cache-Control", "private, no-store");
    if (!user.robloxUserId) return { data: [] };

    const result = await pool.query(
      `SELECT inv.id, inv.role, inv.created_at,
              p.id AS project_id, p.name AS project_name,
              p.roblox_universe_id, p.icon_url,
              inviter.roblox_username AS inviter_username,
              inviter.roblox_display_name AS inviter_display_name
       FROM project_invitations inv
       JOIN projects p ON p.id = inv.project_id
       LEFT JOIN users inviter ON inviter.id = inv.invited_by
       WHERE inv.roblox_user_id = $1
         AND inv.accepted_at IS NULL
         AND inv.revoked_at IS NULL
       ORDER BY inv.created_at DESC, inv.id DESC`,
      [user.robloxUserId],
    );

    return {
      data: result.rows.map((row) => ({
        id: row.id,
        role: row.role,
        createdAt: new Date(row.created_at).toISOString(),
        project: {
          id: row.project_id,
          name: row.project_name,
          robloxUniverseId: row.roblox_universe_id,
          iconUrl: row.icon_url,
        },
        invitedBy: {
          username: row.inviter_username,
          displayName: row.inviter_display_name,
        },
      })),
    };
  });

  app.post(
    "/v1/invitations/:invitationId/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = requireReadUser(request);
      const { invitationId } = recipientInvitationParamsSchema.parse(request.params);
      if (!user.robloxUserId) {
        throw new ReadApiError(403, "roblox_account_required", "Connect a Roblox account before responding to invitations.");
      }

      const client = await beginTransaction(pool);
      try {
        const invitation = await client.query<{ project_id: string; role: "admin" | "member" | "viewer" }>(
          `UPDATE project_invitations
           SET accepted_at = now(), accepted_by = $1
           WHERE id = $2
             AND roblox_user_id = $3
             AND accepted_at IS NULL
             AND revoked_at IS NULL
           RETURNING project_id, role`,
          [user.id, invitationId, user.robloxUserId],
        );
        const accepted = invitation.rows[0];
        if (!accepted) {
          throw new ReadApiError(404, "invitation_not_found", "The pending invitation was not found.");
        }
        await client.query(
          `INSERT INTO project_memberships (user_id, project_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, project_id) DO NOTHING`,
          [user.id, accepted.project_id, accepted.role],
        );
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/v1/invitations/:invitationId/decline",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = requireReadUser(request);
      const { invitationId } = recipientInvitationParamsSchema.parse(request.params);
      if (!user.robloxUserId) {
        throw new ReadApiError(403, "roblox_account_required", "Connect a Roblox account before responding to invitations.");
      }
      const result = await pool.query(
        `UPDATE project_invitations
         SET revoked_at = now()
         WHERE id = $1
           AND roblox_user_id = $2
           AND accepted_at IS NULL
           AND revoked_at IS NULL
         RETURNING id`,
        [invitationId, user.robloxUserId],
      );
      if (!result.rowCount) throw new ReadApiError(404, "invitation_not_found", "The pending invitation was not found.");
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/manage/universes/:universeId",
    { preHandler: authenticate },
    async (request) => {
      const { universeId } = universeParamsSchema.parse(request.params);
      const metadata = await getGameMetadata(universeId);
      if (!metadata.name) throw new ReadApiError(404, "universe_not_found", "That Roblox universe was not found.");
      const claimed = await pool.query("SELECT 1 FROM projects WHERE roblox_universe_id = $1", [universeId]);
      return { ...metadata, available: claimed.rowCount === 0 };
    },
  );

  app.get(
    "/v1/manage/roblox-users/:username",
    { preHandler: authenticate },
    async (request) => {
      const { username } = robloxUsernameParamsSchema.parse(request.params);
      return resolveRobloxUsername(username);
    },
  );

  app.get("/v1/manage/projects", { preHandler: authenticate }, async (request) => {
    const user = requireReadUser(request);
    const result = await pool.query(
      `SELECT p.id, p.name, p.roblox_universe_id, p.icon_url, pm.role,
              key.key_hint, key.created_at AS key_created_at,
              COUNT(inv.id) FILTER (WHERE inv.accepted_at IS NULL AND inv.revoked_at IS NULL)::int AS pending_invitation_count
       FROM projects p
       JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT key_hint, created_at FROM project_api_keys
         WHERE project_id = p.id AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) key ON true
       LEFT JOIN project_invitations inv ON inv.project_id = p.id
       GROUP BY p.id, pm.role, key.key_hint, key.created_at
       ORDER BY p.name, p.id`,
      [user.id],
    );
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        robloxUniverseId: row.roblox_universe_id,
        iconUrl: row.icon_url,
        role: row.role,
        keyHint: row.key_hint,
        keyCreatedAt: row.key_created_at ? new Date(row.key_created_at).toISOString() : null,
        pendingInvitationCount: row.pending_invitation_count,
      })),
    };
  });

  app.get(
    "/v1/manage/projects/:projectId/members",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner", "admin"]);
      const result = await pool.query(
        `SELECT u.id, u.roblox_user_id, u.roblox_username,
                u.roblox_display_name, u.roblox_avatar_url,
                pm.role, pm.created_at
         FROM project_memberships pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1
         ORDER BY CASE pm.role
           WHEN 'owner' THEN 1
           WHEN 'admin' THEN 2
           WHEN 'member' THEN 3
           ELSE 4
         END, COALESCE(u.roblox_display_name, u.roblox_username, u.name), u.id`,
        [projectId],
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        data: result.rows.map((row) => ({
          id: row.id,
          role: row.role,
          joinedAt: new Date(row.created_at).toISOString(),
          robloxUserId: row.roblox_user_id,
          robloxUsername: row.roblox_username,
          robloxDisplayName: row.roblox_display_name,
          robloxAvatarUrl: row.roblox_avatar_url,
        })),
      };
    },
  );

  app.delete(
    "/v1/projects/:projectId/membership",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = requireReadUser(request);
      const { projectId } = projectParamsSchema.parse(request.params);
      const client = await beginTransaction(pool);
      try {
        const membership = await client.query<{ role: "owner" | "admin" | "member" | "viewer" }>(
          `SELECT role FROM project_memberships
           WHERE user_id = $1 AND project_id = $2
           FOR UPDATE`,
          [user.id, projectId],
        );
        const role = membership.rows[0]?.role;
        if (!role) throw new ReadApiError(404, "membership_not_found", "You are not a member of this game.");
        if (role === "owner") {
          throw new ReadApiError(409, "owner_cannot_leave", "Transfer ownership before leaving this game.");
        }
        await client.query(
          "DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2",
          [user.id, projectId],
        );
        await client.query(
          `UPDATE project_invitations SET revoked_at = now()
           WHERE project_id = $1 AND accepted_by = $2 AND revoked_at IS NULL`,
          [projectId, user.id],
        );
        await client.query("COMMIT");
        invalidateProjectMembership(pool, user.id, projectId);
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete(
    "/v1/manage/projects/:projectId/members/:userId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireReadUser(request);
      const { projectId, userId } = memberParamsSchema.parse(request.params);
      if (actor.id === userId) {
        throw new ReadApiError(400, "use_leave_membership", "Use the leave-team action to remove your own access.");
      }

      const client = await beginTransaction(pool);
      try {
        const actorMembership = await client.query<{ role: "owner" | "admin" | "member" | "viewer" }>(
          `SELECT role FROM project_memberships
           WHERE user_id = $1 AND project_id = $2
           FOR UPDATE`,
          [actor.id, projectId],
        );
        const actorRole = actorMembership.rows[0]?.role;
        if (actorRole !== "owner" && actorRole !== "admin") {
          throw new ReadApiError(403, "project_role_forbidden", "Your project role does not allow this action.");
        }
        const targetMembership = await client.query<{ role: "owner" | "admin" | "member" | "viewer" }>(
          `SELECT role FROM project_memberships
           WHERE user_id = $1 AND project_id = $2
           FOR UPDATE`,
          [userId, projectId],
        );
        const targetRole = targetMembership.rows[0]?.role;
        if (!targetRole) throw new ReadApiError(404, "member_not_found", "That team member was not found.");
        const canRemove = actorRole === "owner"
          ? targetRole !== "owner"
          : targetRole === "member" || targetRole === "viewer";
        if (!canRemove) {
          throw new ReadApiError(403, "member_rank_forbidden", "You can only remove team members below your role.");
        }
        await client.query(
          "DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2",
          [userId, projectId],
        );
        await client.query(
          `UPDATE project_invitations SET revoked_at = now()
           WHERE project_id = $1 AND accepted_by = $2 AND revoked_at IS NULL`,
          [projectId, userId],
        );
        await client.query("COMMIT");
        invalidateProjectMembership(pool, userId, projectId);
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post("/v1/manage/projects", { preHandler: authenticate }, async (request, reply) => {
    const user = requireReadUser(request);
    const { universeId } = universeParamsSchema.parse(request.body);
    const metadata = await getGameMetadata(universeId);
    if (!metadata.name) throw new ReadApiError(404, "universe_not_found", "That Roblox universe was not found.");
    const ingestionKey = `tr_ingest_${randomToken(32)}`;
    const keyHint = `••••${ingestionKey.slice(-6)}`;
    const client = await beginTransaction(pool);
    try {
      const verification = await client.query(
        `DELETE FROM verified_universe_claims
         WHERE user_id = $1 AND universe_id = $2 AND expires_at > now()
         RETURNING universe_id`,
        [user.id, universeId],
      );
      if (verification.rowCount !== 1) {
        throw new ReadApiError(403, "universe_verification_required", "Verify ownership with Roblox before linking this experience.");
      }
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects (name, roblox_universe_id, icon_url)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [metadata.name, universeId, metadata.iconUrl],
      );
      const projectId = project.rows[0]!.id;
      await client.query(
        "INSERT INTO project_memberships (user_id, project_id, role) VALUES ($1, $2, 'owner')",
        [user.id, projectId],
      );
      await client.query(
        `INSERT INTO project_api_keys (project_id, key_hash, key_hint, label)
         VALUES ($1, $2, $3, 'Initial Roblox ingestion key')`,
        [projectId, hash(ingestionKey), keyHint],
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        project: { id: projectId, name: metadata.name, robloxUniverseId: universeId, iconUrl: metadata.iconUrl, role: "owner" },
        ingestionKey,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ReadApiError(409, "universe_already_linked", "That experience is already linked to Trace.");
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.post(
    "/v1/manage/projects/:projectId/keys/rotate",
    { preHandler: authenticate },
    async (request) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner", "admin"]);
      const ingestionKey = `tr_ingest_${randomToken(32)}`;
      const keyHint = `••••${ingestionKey.slice(-6)}`;
      const client = await beginTransaction(pool);
      try {
        await client.query(
          "UPDATE project_api_keys SET revoked_at = now() WHERE project_id = $1 AND revoked_at IS NULL",
          [projectId],
        );
        await client.query(
          `INSERT INTO project_api_keys (project_id, key_hash, key_hint, label)
           VALUES ($1, $2, $3, 'Rotated Roblox ingestion key')`,
          [projectId, hash(ingestionKey), keyHint],
        );
        await client.query("COMMIT");
        return { ingestionKey, keyHint };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/v1/manage/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner"]);
      const result = await pool.query(
        `SELECT id, roblox_user_id, roblox_username, role, created_at,
                accepted_at, revoked_at
         FROM project_invitations
         WHERE project_id = $1
         ORDER BY created_at DESC`,
        [projectId],
      );
      return {
        data: result.rows.map((row) => ({
          id: row.id,
          robloxUserId: row.roblox_user_id,
          robloxUsername: row.roblox_username,
          role: row.role,
          createdAt: new Date(row.created_at).toISOString(),
          status: row.revoked_at ? "revoked" : row.accepted_at ? "accepted" : "pending",
        })),
      };
    },
  );

  app.post(
    "/v1/manage/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const { user } = await requireProjectRole(pool, request, projectId, ["owner"]);
      const input = inviteSchema.parse(request.body);
      const robloxUser = await resolveRobloxUsername(input.username);
      if (robloxUser.id === user.robloxUserId) {
        throw new ReadApiError(400, "cannot_invite_self", "You already own this project.");
      }
      const existingMember = await pool.query(
        `SELECT 1 FROM project_memberships pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND u.roblox_user_id = $2`,
        [projectId, robloxUser.id],
      );
      if (existingMember.rowCount) {
        throw new ReadApiError(409, "already_a_member", "That Roblox user already has access.");
      }
      try {
        const invitation = await pool.query<{ id: string }>(
          `INSERT INTO project_invitations (
             project_id, invited_by, roblox_user_id, roblox_username, role
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [projectId, user.id, robloxUser.id, robloxUser.name, input.role],
        );
        return reply.code(201).send({ id: invitation.rows[0]!.id, robloxUserId: robloxUser.id, robloxUsername: robloxUser.name });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ReadApiError(409, "invitation_exists", "That Roblox user already has a pending invitation.");
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/manage/projects/:projectId/invitations/:invitationId",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, invitationId } = invitationParamsSchema.parse(request.params);
      await requireProjectRole(pool, request, projectId, ["owner"]);
      const result = await pool.query(
        `UPDATE project_invitations SET revoked_at = now()
         WHERE id = $1 AND project_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
        [invitationId, projectId],
      );
      if (!result.rowCount) throw new ReadApiError(404, "invitation_not_found", "The pending invitation was not found.");
      return reply.code(204).send();
    },
  );
}
