import { createArchiveStorage } from "./archive-storage.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool, withTransaction } from "./db.js";
import { archiveEligiblePartitions } from "./telemetry-archive.js";
import { startAIClassificationWorker } from "./ai-classification.js";

const ingestionPool = createPool(config.DATABASE_URL, 16);
const readPool = createPool(config.DATABASE_URL, 8);
const classificationPool = config.OPENROUTER_API_KEY
  ? createPool(
      config.DATABASE_URL,
      Math.max(2, config.AI_CLASSIFICATION_CONCURRENCY + 1),
    )
  : null;
const oauth =
  config.ROBLOX_OAUTH_CLIENT_ID &&
  config.ROBLOX_OAUTH_CLIENT_SECRET &&
  config.ROBLOX_OAUTH_REDIRECT_URI
    ? {
        clientId: config.ROBLOX_OAUTH_CLIENT_ID,
        clientSecret: config.ROBLOX_OAUTH_CLIENT_SECRET,
        redirectUri: config.ROBLOX_OAUTH_REDIRECT_URI,
      }
    : null;
const archiveStorage = createArchiveStorage(config);
const app = await buildApp(
  ingestionPool,
  config.WEB_ORIGIN,
  oauth,
  readPool,
  archiveStorage,
);
let maintenanceTimer: NodeJS.Timeout | undefined;
let stopClassificationWorkers: (() => Promise<void>) | undefined;

async function runMaintenance(): Promise<void> {
  await ingestionPool.query("SELECT ensure_occurrence_partitions(3)");
  if (config.ARCHIVE_ENABLED) {
    if (!archiveStorage) {
      throw new Error("archive storage is enabled but not configured");
    }
    const archived = await archiveEligiblePartitions(ingestionPool, archiveStorage);
    app.log.info(archived, "eligible occurrence partitions archived");
    if (!archived.lockAcquired) return;
  }
  // Retention can require an ACCESS EXCLUSIVE lock while dropping an expired
  // partition. Keep maintenance best-effort so it cannot queue normal traffic
  // behind a long-running purge.
  await withTransaction(ingestionPool, async (client) => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      "SELECT purge_expired_trace_data(INTERVAL '24 hours', INTERVAL '3 days')",
    );
    await client.query(
      "SELECT purge_expired_display_error_impacts(INTERVAL '3 days')",
    );
    await client.query(
      `DELETE FROM display_error_variants_hourly
       WHERE bucket_at < now() - INTERVAL '3 days'`,
    );
  });
}

app.addHook("onClose", async () => {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  await stopClassificationWorkers?.();
  archiveStorage?.close();
  await Promise.all([
    ingestionPool.end(),
    readPool.end(),
    classificationPool?.end(),
  ]);
});

try {
  await ingestionPool.query("SELECT ensure_occurrence_partitions(3)");

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
