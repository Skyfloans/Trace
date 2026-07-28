import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ArchiveStorage } from "../archive-storage.js";
import { registerAccountRoutes, type RobloxOAuthConfig } from "./account.js";
import { createReadAuthenticator } from "./auth.js";
import { registerJobRoutes } from "./jobs.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { registerProjectAndErrorRoutes } from "./projects-errors.js";
import { registerRobloxMetadataRoutes } from "./roblox.js";
import { registerRobloxAutofixRoutes } from "./roblox-autofix.js";
import { registerRobloxPlaceAccessRoutes } from "./roblox-place-access.js";
import { registerRobloxPluginAuthRoutes } from "./roblox-plugin-auth.js";
import { registerSessionAndLogRoutes } from "./sessions-logs.js";

export async function registerReadApi(
  app: FastifyInstance,
  pool: Pool,
  oauth: RobloxOAuthConfig | null = null,
  archiveStorage: ArchiveStorage | null = null,
  webOrigin = "http://localhost:5173",
  autofix: { available: boolean; model: string } = {
    available: false,
    model: "openai/gpt-5.4-nano",
  },
): Promise<void> {
  const authenticate = createReadAuthenticator(pool);
  await registerAccountRoutes(app, pool, authenticate, oauth);
  await registerRobloxPluginAuthRoutes(
    app,
    pool,
    authenticate,
    webOrigin,
  );
  await registerRobloxPlaceAccessRoutes(
    app,
    pool,
    authenticate,
    oauth,
    archiveStorage,
  );
  await registerRobloxAutofixRoutes(
    app,
    pool,
    autofix.model,
    autofix.available,
  );
  await registerProjectAndErrorRoutes(app, pool, authenticate);
  await registerFeedbackRoutes(app, pool, authenticate);
  await registerSessionAndLogRoutes(app, pool, authenticate, archiveStorage);
  await registerJobRoutes(app, pool, authenticate);
  await registerRobloxMetadataRoutes(app, pool, authenticate);
}
