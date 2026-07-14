import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintEvent } from "../src/fingerprint.js";
import { ingestBatchSchema } from "../src/schema.js";

function makeBatch(playerName: string) {
  const timestamp = "2026-07-13T23:00:00.000Z";
  const sessionId = "10000000-0000-4000-8000-000000000001";

  return ingestBatchSchema.parse({
    version: 1,
    batchId: "20000000-0000-4000-8000-000000000001",
    job: {
      id: "30000000-0000-4000-8000-000000000001",
      robloxJobId: "40000000-0000-4000-8000-000000000001",
      placeId: "123",
      startedAt: timestamp,
      lastSeenAt: timestamp,
    },
    sessions: [
      {
        id: sessionId,
        playerId: "456",
        playerName,
        startedAt: timestamp,
        lastSeenAt: timestamp,
      },
    ],
    events: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        sessionId,
        occurredAt: timestamp,
        source: "client",
        level: "error",
        message: `${playerName} is not a valid member of Workspace`,
        stack: `Players.${playerName}.PlayerScripts.Test, Line 10`,
        sourceScript: `Players.${playerName}.PlayerScripts.Test`,
      },
    ],
  });
}

test("player names do not create distinct fingerprints", () => {
  const firstBatch = makeBatch("Skyfloans");
  const secondBatch = makeBatch("AnotherPlayer");
  const first = fingerprintEvent(firstBatch.events[0]!, firstBatch);
  const second = fingerprintEvent(secondBatch.events[0]!, secondBatch);

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(
    first.normalizedMessage,
    "<PLAYER_NAME> is not a valid member of Workspace",
  );
  assert.equal(
    first.normalizedSourceScript,
    "Players.<PLAYER_NAME>.PlayerScripts.Test",
  );
});

test("session lifecycle batches do not require an event", () => {
  const batch = makeBatch("Skyfloans");
  const parsed = ingestBatchSchema.parse({
    ...batch,
    events: [],
  });

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.events.length, 0);
});
