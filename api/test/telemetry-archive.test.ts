import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { decodeArchiveChunk } from "../src/telemetry-archive.js";

test("telemetry archive chunks round trip their occurrence payload", () => {
  const occurrence = {
    id: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    occurredAt: "2026-07-18T12:00:00.000Z",
    lastOccurredAt: "2026-07-18T12:00:01.000Z",
    repeatCount: 2,
    receivedAt: "2026-07-18T12:00:02.000Z",
    severity: "error",
    side: "server",
    message: "test error",
    source: null,
    stackTrace: null,
    fingerprint: "fingerprint",
    serverJobId: "30000000-0000-4000-8000-000000000001",
    sessionId: null,
    player: null,
    attributes: {},
  };
  const body = gzipSync(
    JSON.stringify({ version: 1, occurrences: [occurrence] }),
  );

  assert.deepEqual(decodeArchiveChunk(body), [occurrence]);
});

test("telemetry archive chunks reject unsupported versions", () => {
  const body = gzipSync(JSON.stringify({ version: 2, occurrences: [] }));
  assert.throws(() => decodeArchiveChunk(body), /unsupported or invalid/);
});
