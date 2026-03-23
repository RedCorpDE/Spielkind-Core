import { config } from "./config.js";
import { testConnection, pool } from "./db/client.js";
import { startWebhookServer } from "./webhook/server.js";

async function main(): Promise<void> {
  console.log("=== Buchungssystem Control Node ===");
  console.log(`  Environment:    ${config.nodeEnv}`);
  console.log(`  Regiondo URL:   ${config.regiondo.baseUrl}`);
  console.log(`  Webhook port:   ${config.webhook.port}`);
  console.log("");

  await testConnection();
  await startWebhookServer();

  console.log("[Control Node] Ready — waiting for webhook events.");
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