import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool } from "./db.js";

const pool = createPool(config.DATABASE_URL);
const app = await buildApp(pool, config.WEB_ORIGIN);
let maintenanceTimer: NodeJS.Timeout | undefined;

async function runMaintenance(): Promise<void> {
  await pool.query("SELECT ensure_occurrence_partitions(3)");
  await pool.query(
    "SELECT purge_expired_trace_data(INTERVAL '24 hours', INTERVAL '3 days')",
  );
}

app.addHook("onClose", async () => {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  await pool.end();
});

try {
  await runMaintenance();
  await app.listen({ host: config.HOST, port: config.PORT });

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
