import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createReadAuthenticator } from "./auth.js";
import { registerJobRoutes } from "./jobs.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { registerProjectAndErrorRoutes } from "./projects-errors.js";
import { registerRobloxMetadataRoutes } from "./roblox.js";
import { registerSessionAndLogRoutes } from "./sessions-logs.js";

export async function registerReadApi(
  app: FastifyInstance,
  pool: Pool,
): Promise<void> {
  const authenticate = createReadAuthenticator(pool);
  await registerProjectAndErrorRoutes(app, pool, authenticate);
  await registerFeedbackRoutes(app, pool, authenticate);
  await registerSessionAndLogRoutes(app, pool, authenticate);
  await registerJobRoutes(app, pool, authenticate);
  await registerRobloxMetadataRoutes(app, pool, authenticate);
}
