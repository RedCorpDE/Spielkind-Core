import { config } from "./config.js";
import { testConnection, pool } from "./db/client.js";
import { runIncrementalSync } from "./sync/sync-service.js";

const INTERVAL_MS = config.syncIntervalMinutes * 60 * 1_000;

async function main(): Promise<void> {
  console.log("=== Buchungssystem Control Node ===");
  console.log(`  Environment:    ${config.nodeEnv}`);
  console.log(`  Sync interval:  ${config.syncIntervalMinutes} min`);
  console.log(`  Regiondo URL:   ${config.regiondo.baseUrl}`);
  console.log("");

  await testConnection();

  console.log("[Control Node] Running initial sync ...");
  await runIncrementalSync();

  console.log(
    `[Control Node] Scheduling sync every ${config.syncIntervalMinutes} min`
  );
  setInterval(async () => {
    try {
      await runIncrementalSync();
    } catch (err) {
      console.error("[Control Node] Sync cycle failed:", err);
    }
  }, INTERVAL_MS);
}

process.on("SIGTERM", async () => {
  console.log("[Control Node] SIGTERM received, shutting down ...");
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Control Node] SIGINT received, shutting down ...");
  await pool.end();
  process.exit(0);
});

main().catch((err) => {
  console.error("[Control Node] Fatal error:", err);
  process.exit(1);
});
