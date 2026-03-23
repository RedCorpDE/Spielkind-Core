import cron from 'node-cron';
import { appConfig } from './config.js';
import { syncProductsAndVariants } from './sync/sync-service.js';

export function startDailyProductSync(): void {
  cron.schedule(appConfig.PRODUCT_SYNC_CRON, async () => {
    try {
      const count = await syncProductsAndVariants();
      console.log(`[scheduler] Synced ${count} products.`);
    } catch (error) {
      console.error('[scheduler] Product sync failed:', error);
    }
  });

  console.log(`[scheduler] Product sync scheduled with cron '${appConfig.PRODUCT_SYNC_CRON}'.`);
}
