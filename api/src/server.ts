import { createArchiveStorage } from "./archive-storage.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import {
  createPool,
  ensureOccurrencePartitions,
} from "./db.js";
import { runRetention } from "./retention.js";
import { archiveEligiblePartitions } from "./telemetry-archive.js";
import { startAIClassificationWorker } from "./ai-classification.js";
import {
  AUTOFIX_SCHEDULE_INTERVAL_MS,
  startRobloxAutofixScheduler,
  startRobloxAutofixWorker,
} from "./roblox-autofix.js";

// Busy games can legitimately queue many different per-fingerprint advisory
// locks at once. Keep enough pool headroom that unrelated ingestion does not
// fail its five-second connection acquisition while those locks resolve.
const ingestionPool = createPool(config.DATABASE_URL, 32);
const readPool = createPool(config.DATABASE_URL, 8);
const classificationPool = config.OPENROUTER_API_KEY
  ? createPool(
      config.DATABASE_URL,
      Math.max(2, config.AI_CLASSIFICATION_CONCURRENCY + 1),
    )
  : null;
const autofixPool =
  config.OPENROUTER_API_KEY && config.ARCHIVE_STORAGE_PROVIDER
    ? createPool(config.DATABASE_URL, 2)
    : null;
const oauth =
  config.ROBLOX_OAUTH_CLIENT_ID &&
  config.ROBLOX_OAUTH_CLIENT_SECRET &&
  config.ROBLOX_OAUTH_REDIRECT_URI
    ? {
        clientId: config.ROBLOX_OAUTH_CLIENT_ID,
        clientSecret: config.ROBLOX_OAUTH_CLIENT_SECRET,
        redirectUri: config.ROBLOX_OAUTH_REDIRECT_URI,
        tokenEncryptionKey: config.ROBLOX_OAUTH_TOKEN_ENCRYPTION_KEY
          ? Buffer.from(config.ROBLOX_OAUTH_TOKEN_ENCRYPTION_KEY, "base64")
          : undefined,
      }
    : null;
const archiveStorage = createArchiveStorage(config);
const autofixModel = config.AUTOFIX_MODEL;
const app = await buildApp(
  ingestionPool,
  config.WEB_ORIGIN,
  oauth,
  readPool,
  archiveStorage,
  {
    available: Boolean(config.OPENROUTER_API_KEY && archiveStorage),
    model: autofixModel,
  },
);
let maintenanceTimer: NodeJS.Timeout | undefined;
let stopClassificationWorkers: (() => Promise<void>) | undefined;
let stopAutofixScheduler: (() => Promise<void>) | undefined;
let stopAutofixWorker: (() => Promise<void>) | undefined;

async function runMaintenance(): Promise<void> {
  await ensureOccurrencePartitions(ingestionPool);
  if (config.ARCHIVE_ENABLED) {
    if (!archiveStorage) {
      throw new Error("archive storage is enabled but not configured");
    }
    const archived = await archiveEligiblePartitions(ingestionPool, archiveStorage);
    app.log.info(archived, "eligible occurrence partitions archived");
    if (!archived.lockAcquired) return;
  }
  await runRetention(ingestionPool, { log: app.log });
}

app.addHook("onClose", async () => {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  await stopClassificationWorkers?.();
  await stopAutofixScheduler?.();
  await stopAutofixWorker?.();
  archiveStorage?.close();
  await Promise.all([
    ingestionPool.end(),
    readPool.end(),
    classificationPool?.end(),
    autofixPool?.end(),
  ]);
});

try {
  await ensureOccurrencePartitions(ingestionPool);

  if (archiveStorage) {
    try {
      const probe = await archiveStorage.verifyReadWrite();
      app.log.info(
        {
          archiveBucket: probe.bucket,
          archiveProvider: probe.provider,
          archiveProbeSha256: probe.sha256,
        },
        "archive storage read/write probe passed",
      );
    } catch (error) {
      if (config.ARCHIVE_ENABLED) throw error;
      app.log.warn(error, "archive storage probe failed; archival remains disabled");
    }
  }

  await app.listen({ host: config.HOST, port: config.PORT });

  if (config.OPENROUTER_API_KEY && classificationPool) {
    const workers = Array.from(
      { length: config.AI_CLASSIFICATION_CONCURRENCY },
      () => startAIClassificationWorker({
        pool: classificationPool,
        apiKey: config.OPENROUTER_API_KEY!,
        model: config.OPENROUTER_MODEL,
        webOrigin: config.WEB_ORIGIN,
        batchSize: config.AI_CLASSIFICATION_BATCH_SIZE,
        logger: app.log,
      }),
    );
    stopClassificationWorkers = async () => {
      await Promise.all(workers.map((stop) => stop()));
    };
    app.log.info(
      {
        model: config.OPENROUTER_MODEL,
        concurrency: config.AI_CLASSIFICATION_CONCURRENCY,
        batchSize: config.AI_CLASSIFICATION_BATCH_SIZE,
      },
      "AI classification worker started",
    );
  } else {
    app.log.warn(
      "OPENROUTER_API_KEY is not configured; AI classifications are paused",
    );
  }

  if (
    config.OPENROUTER_API_KEY &&
    archiveStorage &&
    autofixPool
  ) {
    stopAutofixWorker = startRobloxAutofixWorker({
      pool: autofixPool,
      storage: archiveStorage,
      apiKey: config.OPENROUTER_API_KEY,
      model: autofixModel,
      webOrigin: config.WEB_ORIGIN,
      logger: app.log,
    });
    stopAutofixScheduler = startRobloxAutofixScheduler({
      pool: autofixPool,
      model: autofixModel,
      logger: app.log,
    });
    app.log.info(
      {
        model: autofixModel,
        maxOutstandingProposals: 15,
        concurrency: 1,
        scheduleMinutes: AUTOFIX_SCHEDULE_INTERVAL_MS / 60_000,
      },
      "Roblox autofix worker and scheduler started",
    );
  } else {
    app.log.warn(
      "OpenRouter or place storage is not configured; Roblox autofix is paused",
    );
  }

  void runMaintenance().catch((error: unknown) => {
    app.log.error(error, "initial database maintenance failed");
  });

  maintenanceTimer = setInterval(() => {
    void runMaintenance().catch((error: unknown) => {
      app.log.error(error, "database maintenance failed");
    });
  }, 60 * 60 * 1_000);
  maintenanceTimer.unref();
} catch (error) {
  app.log.error(error, "failed to start ingestion API");
  await app.close();
  process.exitCode = 1;
}
