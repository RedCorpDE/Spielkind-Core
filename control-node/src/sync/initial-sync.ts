/**
 * One-time full import of all existing data from Regiondo.
 *
 * Run manually: npx tsx src/sync/initial-sync.ts
 *
 * Order: Customers -> Products -> Bookings (FK dependencies)
 */

import { testConnection, pool } from "../db/client.js";
import { syncCustomers, syncProducts, syncBookings } from "./sync-service.js";

async function main(): Promise<void> {
  console.log("=== Initial Full Sync from Regiondo ===");
  console.log("");

  await testConnection();

  console.log("[1/3] Syncing all customers ...");
  const customerCount = await syncCustomers();

  console.log("[2/3] Syncing all products ...");
  const productCount = await syncProducts();

  console.log("[3/3] Syncing all bookings ...");
  const bookingCount = await syncBookings();

  console.log("");
  console.log("=== Initial Sync Complete ===");
  console.log(`  Customers: ${customerCount}`);
  console.log(`  Products:  ${productCount}`);
  console.log(`  Bookings:  ${bookingCount}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Initial sync failed:", err);
  process.exit(1);
});
