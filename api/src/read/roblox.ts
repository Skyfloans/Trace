import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireProjectMembership } from "./auth.js";

type Authenticator = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type GameMetadata = {
  universeId: string;
  name: string | null;
  iconUrl: string | null;
};

const projectParamsSchema = z.object({ projectId: z.uuid() });
const playerParamsSchema = projectParamsSchema.extend({
  robloxUserId: z.string().regex(/^\d{1,20}$/),
});
const headshotQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => [...new Set(value.split(","))])
    .pipe(z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(50)),
});
const gameCache = new Map<string, CachedValue<GameMetadata>>();
const headshotCache = new Map<string, CachedValue<string | null>>();
const CACHE_MS = 60 * 60 * 1_000;

async function robloxJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function getGameMetadata(universeId: string): Promise<GameMetadata> {
  const cached = gameCache.get(universeId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const encodedId = encodeURIComponent(universeId);
  const [gameResponse, iconResponse] = await Promise.all([
    robloxJson<{
      data?: Array<{ id?: number; name?: string }>;
    }>(`https://games.roblox.com/v1/games?universeIds=${encodedId}`),
    robloxJson<{
      data?: Array<{ state?: string; imageUrl?: string }>;
    }>(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${encodedId}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`,
    ),
  ]);

  const game = gameResponse?.data?.[0];
  const thumbnail = iconResponse?.data?.[0];
  const name =
    game?.id && game.name && !game.name.startsWith("[")
      ? game.name
      : null;
  const value = {
    universeId,
    name,
    iconUrl:
      thumbnail?.state === "Completed" && thumbnail.imageUrl
        ? thumbnail.imageUrl
        : null,
  };
  gameCache.set(universeId, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

async function getPlayerHeadshots(
  robloxUserIds: string[],
): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const robloxUserId of robloxUserIds) {
    const cached = headshotCache.get(robloxUserId);
    if (cached && cached.expiresAt > Date.now()) {
      values[robloxUserId] = cached.value;
    } else {
      missing.push(robloxUserId);
    }
  }
  if (missing.length === 0) return values;

  const response = await robloxJson<{
    data?: Array<{ targetId?: number; state?: string; imageUrl?: string }>;
  }>(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(missing.join(","))}&size=150x150&format=Png&isCircular=false`,
  );
  const thumbnails = new Map(
    response?.data?.map((thumbnail) => [
      String(thumbnail.targetId),
      thumbnail,
    ]) ?? [],
  );
  for (const robloxUserId of missing) {
    const thumbnail = thumbnails.get(robloxUserId);
    const value =
      thumbnail?.state === "Completed" && thumbnail.imageUrl
        ? thumbnail.imageUrl
        : null;
    values[robloxUserId] = value;
    headshotCache.set(robloxUserId, {
      expiresAt: Date.now() + CACHE_MS,
      value,
    });
  }
  return values;
}

async function getPlayerHeadshot(
  robloxUserId: string,
): Promise<string | null> {
  const values = await getPlayerHeadshots([robloxUserId]);
  return values[robloxUserId] ?? null;
}

export async function registerRobloxMetadataRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: Authenticator,
): Promise<void> {
  app.get(
    "/v1/projects/:projectId/roblox-metadata",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      await requireProjectMembership(pool, request, projectId);
      const result = await pool.query(
        `SELECT roblox_universe_id
         FROM projects
         WHERE id = $1`,
        [projectId],
      );
      const universeId = result.rows[0]?.roblox_universe_id;
      reply.header("Cache-Control", "private, max-age=3600");
      if (!universeId) {
        return { universeId: null, name: null, iconUrl: null };
      }
      return getGameMetadata(String(universeId));
    },
  );

  app.get(
    "/v1/projects/:projectId/player-headshots",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const { ids } = headshotQuerySchema.parse(request.query);
      await requireProjectMembership(pool, request, projectId);
      const players = await pool.query<{ player_id: string }>(
        `SELECT DISTINCT player_id::text AS player_id
         FROM sessions
         WHERE project_id = $1
           AND player_id = ANY($2::bigint[])`,
        [projectId, ids],
      );
      const allowedIds = players.rows.map((row) => String(row.player_id));
      const values = await getPlayerHeadshots(allowedIds);
      reply.header("Cache-Control", "private, max-age=3600");
      return {
        data: Object.fromEntries(
          ids.map((id) => [id, values[id] ?? null]),
        ),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/players/:robloxUserId/headshot",
    { preHandler: authenticate },
    async (request, reply) => {
      const { projectId, robloxUserId } = playerParamsSchema.parse(
        request.params,
      );
      await requireProjectMembership(pool, request, projectId);
      const player = await pool.query(
        `SELECT 1
         FROM sessions
         WHERE project_id = $1 AND player_id = $2
         LIMIT 1`,
        [projectId, robloxUserId],
      );
      reply.header("Cache-Control", "private, max-age=3600");
      if (player.rowCount !== 1) return { imageUrl: null };
      return { imageUrl: await getPlayerHeadshot(robloxUserId) };
    },
  );
}
