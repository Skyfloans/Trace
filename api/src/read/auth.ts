import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { ReadApiError } from "./http.js";

export type ReadUser = {
  id: string;
  email: string;
  name: string | null;
};

const authenticatedUsers = new WeakMap<FastifyRequest, ReadUser>();

function readSessionToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token.length >= 32 ? token : null;
  }

  const token = request.cookies.trace_session;
  return token && token.length >= 32 ? token : null;
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
    const result = await pool.query<ReadUser>(
      `SELECT u.id, u.email, u.name
       FROM web_sessions ws
       JOIN users u ON u.id = ws.user_id
       WHERE ws.token_hash = $1
         AND ws.revoked_at IS NULL
         AND ws.expires_at > now()`,
      [tokenHash],
    );

    const user = result.rows[0];
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
  const result = await pool.query(
    `SELECT 1
     FROM project_memberships
     WHERE user_id = $1 AND project_id = $2`,
    [user.id, projectId],
  );

  if (result.rowCount !== 1) {
    throw new ReadApiError(
      403,
      "project_forbidden",
      "You do not have access to this project.",
    );
  }

  return user;
}
