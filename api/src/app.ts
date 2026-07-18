import { createHash } from "node:crypto";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import { ZodError } from "zod";
import { ingestBatchSchema } from "./schema.js";
import { findProjectForApiKey, ingestBatch, verifyProjectUniverse } from "./repository.js";
import { ReadApiError } from "./read/http.js";
import { registerReadApi } from "./read/index.js";
import type { RobloxOAuthConfig } from "./read/account.js";

const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1_000;

export function ingestionRateLimitKey(request: FastifyRequest): string {
  const body = request.body as
    | { job?: { id?: unknown; robloxJobId?: unknown } }
    | undefined;
  const jobIdentity =
    typeof body?.job?.id === "string"
      ? body.job.id
      : typeof body?.job?.robloxJobId === "string"
        ? body.job.robloxJobId
        : "unknown-job";

  return createHash("sha256")
    .update(request.headers.authorization ?? request.ip)
    .update("\0")
    .update(jobIdentity)
    .digest("hex");
}

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 32 ? token : null;
}

function validateEventTimes(occurredAtValues: string[]): string | null {
  const now = Date.now();
  const oldestAccepted = now - MAX_EVENT_AGE_MS;
  const newestAccepted = now + MAX_FUTURE_SKEW_MS;

  for (const occurredAt of occurredAtValues) {
    const timestamp = Date.parse(occurredAt);
    if (timestamp < oldestAccepted) {
      return "Events older than the 24-hour raw retention window are rejected";
    }
    if (timestamp > newestAccepted) {
      return "Event timestamps cannot be more than ten minutes in the future";
    }
  }

  return null;
}

export async function buildApp(
  pool: Pool,
  webOrigin = "http://localhost:5173",
  oauth: Omit<RobloxOAuthConfig, "webOrigin"> | null = null,
  readPool: Pool = pool,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 512 * 1_024,
    requestIdHeader: "x-trace-request-id",
  });

  await app.register(compress, {
    globalCompression: true,
    globalDecompression: true,
    encodings: ["gzip"],
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: webOrigin,
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: ingestionRateLimitKey,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });

  app.get("/health", async (_request, reply) => {
    await readPool.query("SELECT 1");
    return reply.send({ status: "ok" });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ReadApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: error.issues[0]?.message ?? "The request is invalid.",
          requestId: request.id,
        },
      });
    }

    request.log.error(error);
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
        requestId: request.id,
      },
    });
  });

  app.post(
    "/v1/batches",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          hook: "preHandler",
        },
      },
    },
    async (request, reply) => {
      const apiKey = readBearerToken(request.headers.authorization);
      if (!apiKey) {
        return reply.code(401).send({ error: "Missing or invalid bearer token" });
      }

      const projectId = await findProjectForApiKey(pool, apiKey);
      if (!projectId) {
        return reply.code(401).send({ error: "Invalid or revoked API key" });
      }

      const parsed = ingestBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid batch",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      const timestampError = validateEventTimes(
        [
          ...parsed.data.events.flatMap((event) => [
            event.occurredAt,
            event.lastOccurredAt ?? event.occurredAt,
          ]),
          ...parsed.data.feedback.map((item) => item.submittedAt),
        ],
      );
      if (timestampError) {
        return reply.code(422).send({ error: timestampError });
      }

      const universeId = parsed.data.job.universeId;
      if (!universeId || !(await verifyProjectUniverse(pool, projectId, universeId))) {
        return reply.code(403).send({
          error: "The ingestion key is not configured for this Roblox universe",
        });
      }

      const result = await ingestBatch(pool, projectId, parsed.data);

      request.log.info(
        {
          batchId: parsed.data.batchId,
          projectId,
          accepted: result.accepted,
          duplicates: result.duplicates,
        },
        "ingested telemetry batch",
      );

      return reply.code(200).send({
        batchId: parsed.data.batchId,
        accepted: result.accepted,
        duplicates: result.duplicates,
      });
    },
  );

  await registerReadApi(app, readPool, oauth ? { ...oauth, webOrigin } : null);

  return app;
}
