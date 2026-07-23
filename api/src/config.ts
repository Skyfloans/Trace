import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    ROBLOX_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    ROBLOX_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    ROBLOX_OAUTH_REDIRECT_URI: z.string().url().optional(),
    OPENROUTER_API_KEY: z.string().trim().min(20).optional(),
    OPENROUTER_MODEL: z.string().trim().min(1).default("openai/gpt-5.4-nano"),
    AI_CLASSIFICATION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(32),
    AI_CLASSIFICATION_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(3),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    ARCHIVE_ENABLED: booleanString,
    ARCHIVE_STORAGE_PROVIDER: z.enum(["s3", "spaces", "r2"]).optional(),
    ARCHIVE_S3_ENDPOINT: z.string().url().optional(),
    ARCHIVE_S3_BUCKET: z.string().trim().min(1).optional(),
    ARCHIVE_S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    ARCHIVE_S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    ARCHIVE_S3_REGION: z.string().trim().min(1).default("us-east-1"),
    ARCHIVE_S3_FORCE_PATH_STYLE: booleanString,
    ARCHIVE_S3_PREFIX: z.string().trim().default("trace-telemetry/"),
  })
  .superRefine((environment, context) => {
    const values = [
      environment.ARCHIVE_STORAGE_PROVIDER,
      environment.ARCHIVE_S3_ENDPOINT,
      environment.ARCHIVE_S3_BUCKET,
      environment.ARCHIVE_S3_ACCESS_KEY_ID,
      environment.ARCHIVE_S3_SECRET_ACCESS_KEY,
    ];
    const archiveIsConfigured = environment.ARCHIVE_ENABLED || values.some(Boolean);

    if (!archiveIsConfigured) return;

    const required = [
      "ARCHIVE_STORAGE_PROVIDER",
      "ARCHIVE_S3_ENDPOINT",
      "ARCHIVE_S3_BUCKET",
      "ARCHIVE_S3_ACCESS_KEY_ID",
      "ARCHIVE_S3_SECRET_ACCESS_KEY",
    ] as const;
    for (const key of required) {
      if (!environment[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when archive storage is configured`,
        });
      }
    }
  });

export const config = environmentSchema.parse(process.env);
