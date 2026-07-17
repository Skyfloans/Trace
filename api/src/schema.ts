import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const numericId = z
  .union([
    z.string().regex(/^\d{1,20}$/),
    z.number().int().nonnegative().safe(),
  ])
  .transform(String);

const jobSchema = z
  .object({
    id: z.uuid(),
    robloxJobId: z.string().min(1).max(128),
    placeId: numericId,
    universeId: numericId.optional(),
    region: z.string().max(64).optional(),
    release: z.string().max(128).optional(),
    startedAt: timestamp,
    endedAt: timestamp.optional(),
    lastSeenAt: timestamp,
  })
  .strict();

const sessionSchema = z
  .object({
    id: z.uuid(),
    playerId: numericId,
    playerName: z.string().min(1).max(64).optional(),
    playerDisplayName: z.string().min(1).max(64).optional(),
    device: z.string().max(64).optional(),
    platform: z.string().max(64).optional(),
    startedAt: timestamp,
    endedAt: timestamp.optional(),
    lastSeenAt: timestamp,
    endReason: z.string().max(128).optional(),
  })
  .strict();

const eventSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid().optional(),
    occurredAt: timestamp,
    lastOccurredAt: timestamp.optional(),
    repeatCount: z.number().int().min(1).max(10_000).default(1),
    source: z.enum(["client", "server"]),
    level: z.enum(["trace", "info", "warning", "error"]),
    message: z.string().min(1).max(4_000),
    stack: z.string().max(16_000).optional(),
    sourceScript: z.string().max(512).optional(),
    context: z.record(z.string().max(64), z.json()).optional(),
  })
  .strict();

const feedbackSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    submittedAt: timestamp,
    message: z.string().trim().min(8).max(221),
  })
  .strict();

export const ingestBatchSchema = z
  .object({
    version: z.literal(1),
    batchId: z.uuid(),
    job: jobSchema,
    sessions: z.array(sessionSchema).max(100).default([]),
    events: z.array(eventSchema).max(100).default([]),
    feedback: z.array(feedbackSchema).max(100).default([]),
  })
  .strict()
  .superRefine((batch, context) => {
    const sessionIds = new Set(batch.sessions.map((session) => session.id));
    if (sessionIds.size !== batch.sessions.length) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Session IDs must be unique within a batch",
      });
    }

    for (const [index, event] of batch.events.entries()) {
      if (
        event.lastOccurredAt &&
        Date.parse(event.lastOccurredAt) < Date.parse(event.occurredAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "lastOccurredAt"],
          message: "lastOccurredAt cannot be earlier than occurredAt",
        });
      }

      if (
        event.source === "client" &&
        (!event.sessionId || !sessionIds.has(event.sessionId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sessionId"],
          message: "Client events must reference a session included in the batch",
        });
      }

      if (event.source === "server" && event.sessionId) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sessionId"],
          message: "Server events belong to the job and cannot reference a session",
        });
      }
    }

    for (const [index, feedback] of batch.feedback.entries()) {
      if (!sessionIds.has(feedback.sessionId)) {
        context.addIssue({
          code: "custom",
          path: ["feedback", index, "sessionId"],
          message: "Feedback must reference a session included in the batch",
        });
      }
    }
  });

export type IngestBatch = z.infer<typeof ingestBatchSchema>;
export type IngestEvent = IngestBatch["events"][number];
