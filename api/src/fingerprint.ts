import { createHash } from "node:crypto";
import type { IngestBatch, IngestEvent } from "./schema.js";

const uuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const isoTimestampPattern =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const memoryAddressPattern = /\b0x[0-9a-f]+\b/gi;
const replicatedMountPlayerIdPattern = /(ReplicatedMounts\.)\d{3,20}\b/g;
const serviceUserIdPattern = /(\bUser\s+)\d{3,20}\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePlayerName(value: string, playerName: string): string {
  if (playerName.length < 3) {
    return value;
  }

  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(playerName)}(?=$|[^A-Za-z0-9_])`,
    "gi",
  );

  return value.replace(pattern, "$1<PLAYER_NAME>");
}

function replacePlayerId(value: string, playerId: string): string {
  if (playerId.length < 3) {
    return value;
  }

  const pattern = new RegExp(`(^|\\D)${escapeRegExp(playerId)}(?=$|\\D)`, "g");
  return value.replace(pattern, "$1<PLAYER_ID>");
}

export function normalizeText(value: string, batch: IngestBatch): string {
  let normalized = value.replaceAll("\r\n", "\n").trim();

  if (batch.job.robloxJobId) {
    normalized = normalized.replaceAll(
      batch.job.robloxJobId,
      "<ROBLOX_JOB_ID>",
    );
  }

  for (const session of batch.sessions) {
    if (session.playerName) {
      normalized = replacePlayerName(normalized, session.playerName);
    }
    normalized = replacePlayerId(normalized, session.playerId);
  }

  return normalized
    .replace(replicatedMountPlayerIdPattern, "$1<PLAYER_ID>")
    .replace(serviceUserIdPattern, "$1<PLAYER_ID>")
    .replace(uuidPattern, "<UUID>")
    .replace(isoTimestampPattern, "<TIMESTAMP>")
    .replace(memoryAddressPattern, "<ADDRESS>");
}

export function fingerprintEvent(
  event: IngestEvent,
  batch: IngestBatch,
): {
  fingerprint: string;
  normalizedMessage: string;
  normalizedStack: string | null;
  normalizedSourceScript: string | null;
} {
  const normalizedMessage = normalizeText(event.message, batch);
  const normalizedStack = event.stack
    ? normalizeText(event.stack, batch)
    : null;
  const normalizedSourceScript = event.sourceScript
    ? normalizeText(event.sourceScript, batch)
    : null;

  const identity = [
    event.source,
    event.level,
    normalizedSourceScript ?? "",
    normalizedMessage,
  ].join("\0");

  return {
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    normalizedMessage,
    normalizedStack,
    normalizedSourceScript,
  };
}
