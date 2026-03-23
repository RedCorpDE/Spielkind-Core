import { pool } from '../db/client.js';
import { syncProductsAndVariants } from './sync-service.js';

async function run(): Promise<void> {
  const count = await syncProductsAndVariants();
  console.log(`Synced ${count} products.`);
}

run()
  .catch((error) => {
    console.error('Product sync failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
