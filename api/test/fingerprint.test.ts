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

test("feedback is capped at 221 characters", () => {
  const batch = makeBatch("skyfloans");
  const sessionId = batch.sessions[0]!.id;
  const valid = ingestBatchSchema.safeParse({
    ...batch,
    feedback: [{
      id: "50000000-0000-4000-8000-000000000001",
      sessionId,
      submittedAt: batch.job.startedAt,
      message: "x".repeat(221),
    }],
  });
  const tooLong = ingestBatchSchema.safeParse({
    ...batch,
    feedback: [{
      id: "50000000-0000-4000-8000-000000000002",
      sessionId,
      submittedAt: batch.job.startedAt,
      message: "x".repeat(222),
    }],
  });
  assert.equal(valid.success, true);
  assert.equal(tooLong.success, false);
});

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

test("known player IDs in instance paths do not split error groups", () => {
  const firstBatch = makeBatch("Skyfloans");
  const secondBatch = makeBatch("AnotherPlayer");
  firstBatch.events[0]!.message =
    'Orienter is not a valid member of Model "Workspace.ReplicatedMounts.456"';
  secondBatch.sessions[0]!.playerId = "789";
  secondBatch.events[0]!.message =
    'Orienter is not a valid member of Model "Workspace.ReplicatedMounts.789"';

  const first = fingerprintEvent(firstBatch.events[0]!, firstBatch);
  const second = fingerprintEvent(secondBatch.events[0]!, secondBatch);

  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.normalizedMessage, /<PLAYER_ID>/);
});

test("known Roblox service user IDs normalize without a session hint", () => {
  const firstBatch = makeBatch("Skyfloans");
  const secondBatch = makeBatch("Skyfloans");
  firstBatch.sessions = [];
  secondBatch.sessions = [];
  for (const [batch, playerId] of [
    [firstBatch, "127308559"],
    [secondBatch, "987654321"],
  ] as const) {
    const event = batch.events[0]!;
    delete event.sessionId;
    event.source = "server";
    event.level = "warning";
    event.message = `ExperienceNotificationService: send failed User ${playerId} is not opted in`;
  }

  const first = fingerprintEvent(firstBatch.events[0]!, firstBatch);
  const second = fingerprintEvent(secondBatch.events[0]!, secondBatch);

  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.normalizedMessage, /User <PLAYER_ID>/);
});

test("stack differences do not split an otherwise identical error group", () => {
  const firstBatch = makeBatch("Skyfloans");
  const secondBatch = makeBatch("Skyfloans");
  secondBatch.events[0]!.stack =
    "Players.Skyfloans.PlayerScripts.Test, Line 999\nDifferent caller";

  const first = fingerprintEvent(firstBatch.events[0]!, firstBatch);
  const second = fingerprintEvent(secondBatch.events[0]!, secondBatch);

  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.normalizedStack, second.normalizedStack);
});

test("aggregated events retain their logical count and time span", () => {
  const batch = makeBatch("Skyfloans");
  const event = batch.events[0]!;
  const parsed = ingestBatchSchema.parse({
    ...batch,
    events: [
      {
        ...event,
        lastOccurredAt: "2026-07-13T23:00:04.000Z",
        repeatCount: 47,
      },
    ],
  });

  assert.equal(parsed.events[0]!.repeatCount, 47);
  assert.equal(
    parsed.events[0]!.lastOccurredAt,
    "2026-07-13T23:00:04.000Z",
  );
});

test("aggregate end time cannot precede its first occurrence", () => {
  const batch = makeBatch("Skyfloans");
  const event = batch.events[0]!;

  assert.throws(() =>
    ingestBatchSchema.parse({
      ...batch,
      events: [
        {
          ...event,
          lastOccurredAt: "2026-07-13T22:59:59.000Z",
        },
      ],
    }),
  );
});
