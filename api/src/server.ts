import { createArchiveStorage } from "./archive-storage.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool } from "./db.js";
import { archiveEligiblePartitions } from "./telemetry-archive.js";

const ingestionPool = createPool(config.DATABASE_URL, 16);
const readPool = createPool(config.DATABASE_URL, 8);
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
  await ingestionPool.query(
    "SELECT purge_expired_trace_data(INTERVAL '24 hours', INTERVAL '3 days')",
  );
}

app.addHook("onClose", async () => {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  archiveStorage?.close();
  await Promise.all([ingestionPool.end(), readPool.end()]);
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
