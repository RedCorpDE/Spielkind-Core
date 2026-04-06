import cron from 'node-cron';
import { appConfig } from './config.js';
import { syncProductsAndVariants } from './sync/sync-service.js';
import { clientMessage7dJob } from './outbound/client-message-7d.js';
import { clientMessage1dJob } from './outbound/client-message-1d.js';
import { checkOutJob } from './outbound/check-out.js';

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

export function registerOutboundJobs(): void {
  if (!appConfig.OUTBOUND_ENABLED) {
    console.log('[scheduler] Outbound jobs disabled (OUTBOUND_ENABLED=false).');
    return;
  }

  // All three jobs run every 5 minutes. The job-runner handles idempotency and locking.
  cron.schedule('*/5 * * * *', clientMessage7dJob);
  cron.schedule('*/5 * * * *', clientMessage1dJob);
  cron.schedule('*/5 * * * *', checkOutJob);

  console.log('[scheduler] Outbound jobs registered (every 5 minutes).');
}
