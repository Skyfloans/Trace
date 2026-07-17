import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { ReadApiError } from "./http.js";

export type ReadUser = {
  id: string;
  email: string | null;
  name: string | null;
  robloxUserId: string | null;
  robloxUsername: string | null;
  robloxDisplayName: string | null;
  robloxAvatarUrl: string | null;
};

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type AuthCache = {
  users: Map<string, CachedValue<ReadUser>>;
  userLoads: Map<string, Promise<ReadUser | null>>;
  memberships: Map<string, number>;
  membershipLoads: Map<string, Promise<boolean>>;
};

const authenticatedUsers = new WeakMap<FastifyRequest, ReadUser>();
const authCaches = new WeakMap<Pool, AuthCache>();
const AUTH_CACHE_MS = 15_000;

function getAuthCache(pool: Pool): AuthCache {
  const existing = authCaches.get(pool);
  if (existing) return existing;

  const created: AuthCache = {
    users: new Map(),
    userLoads: new Map(),
    memberships: new Map(),
    membershipLoads: new Map(),
  };
  authCaches.set(pool, created);
  return created;
}

async function loadReadUser(
  pool: Pool,
  tokenHash: Buffer,
  cacheKey: string,
): Promise<ReadUser | null> {
  const cache = getAuthCache(pool);
  const cached = cache.users.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.users.delete(cacheKey);

  const pending = cache.userLoads.get(cacheKey);
  if (pending) return pending;

  const load = pool
    .query<ReadUser>(
      `SELECT u.id, u.email, u.name,
              u.roblox_user_id AS "robloxUserId",
              u.roblox_username AS "robloxUsername",
              u.roblox_display_name AS "robloxDisplayName",
              u.roblox_avatar_url AS "robloxAvatarUrl"
       FROM web_sessions ws
       JOIN users u ON u.id = ws.user_id
       WHERE ws.token_hash = $1
         AND ws.revoked_at IS NULL
         AND ws.expires_at > now()`,
      [tokenHash],
    )
    .then((result) => {
      const user = result.rows[0] ?? null;
      if (user) {
        cache.users.set(cacheKey, {
          expiresAt: Date.now() + AUTH_CACHE_MS,
          value: user,
        });
      }
      return user;
    })
    .finally(() => cache.userLoads.delete(cacheKey));

  cache.userLoads.set(cacheKey, load);
  return load;
}

function readSessionToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token.length >= 32 ? token : null;
  }

  const token = request.cookies.trace_session;
  return token && token.length >= 32 ? token : null;
}

export async function findReadUserForRequest(
  pool: Pool,
  request: FastifyRequest,
): Promise<ReadUser | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest();
  return loadReadUser(pool, tokenHash, tokenHash.toString("hex"));
}

export function createReadAuthenticator(pool: Pool) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = readSessionToken(request);
    if (!token) {
      await reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "A website session is required.",
          requestId: request.id,
        },
      });
      return;
    }

    const tokenHash = createHash("sha256").update(token).digest();
    const user = await loadReadUser(pool, tokenHash, tokenHash.toString("hex"));
    if (!user) {
      await reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "The website session is invalid or expired.",
          requestId: request.id,
        },
      });
      return;
    }

    authenticatedUsers.set(request, user);
  };
}

export function requireReadUser(request: FastifyRequest): ReadUser {
  const user = authenticatedUsers.get(request);
  if (!user) {
    throw new ReadApiError(
      401,
      "unauthenticated",
      "A website session is required.",
    );
  }
  return user;
}

export async function requireProjectMembership(
  pool: Pool,
  request: FastifyRequest,
  projectId: string,
): Promise<ReadUser> {
  const user = requireReadUser(request);
  const cache = getAuthCache(pool);
  const cacheKey = `${user.id}:${projectId}`;
  const cachedUntil = cache.memberships.get(cacheKey);
  if (cachedUntil && cachedUntil > Date.now()) return user;
  if (cachedUntil) cache.memberships.delete(cacheKey);

  let membership = cache.membershipLoads.get(cacheKey);
  if (!membership) {
    membership = pool
      .query(
        `SELECT 1
         FROM project_memberships
         WHERE user_id = $1 AND project_id = $2`,
        [user.id, projectId],
      )
      .then((result) => result.rowCount === 1)
      .finally(() => cache.membershipLoads.delete(cacheKey));
    cache.membershipLoads.set(cacheKey, membership);
  }

  if (!(await membership)) {
    throw new ReadApiError(
      403,
      "project_forbidden",
      "You do not have access to this project.",
    );
  }

  cache.memberships.set(cacheKey, Date.now() + AUTH_CACHE_MS);
  return user;
}

export async function requireProjectRole(
  pool: Pool,
  request: FastifyRequest,
  projectId: string,
  allowedRoles: Array<"owner" | "admin" | "member" | "viewer">,
): Promise<{ user: ReadUser; role: "owner" | "admin" | "member" | "viewer" }> {
  const user = requireReadUser(request);
  const result = await pool.query<{ role: "owner" | "admin" | "member" | "viewer" }>(
    `SELECT role
     FROM project_memberships
     WHERE user_id = $1 AND project_id = $2`,
    [user.id, projectId],
  );
  const role = result.rows[0]?.role;
  if (!role || !allowedRoles.includes(role)) {
    throw new ReadApiError(
      403,
      "project_role_forbidden",
      "Your project role does not allow this action.",
    );
  }
  return { user, role };
}
