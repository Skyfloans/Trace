import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  ROBLOX_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  ROBLOX_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  ROBLOX_OAUTH_REDIRECT_URI: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export const config = environmentSchema.parse(process.env);
