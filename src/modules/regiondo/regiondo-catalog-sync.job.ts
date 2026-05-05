import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { startSync, finishSync, failSync } from '../../sync/sync-log.js';
import { fetchRegiondoCatalogProducts } from './regiondo-catalog-sync.service.js';
import { syncRegiondoCatalogProducts } from './regiondo-catalog.repository.js';

export async function runRegiondoCatalogSyncJob() {
  return runJobWithLock({
    jobType: JOB_TYPES.SYNC_REGIONDO_CATALOG,
    handler: async () => {
      const syncId = await startSync('regiondo_catalog');

      try {
        const result = await fetchRegiondoCatalogProducts();
        await syncRegiondoCatalogProducts(result.products, {
          errorCount: result.errors.length,
          stats: result.stats
        });
        await finishSync(syncId, result.products.length);

        return {
          recordsProcessed: result.products.length,
          metadata: {
            errorCount: result.errors.length,
            productCount: result.products.length,
            stats: result.stats
          }
        };
      } catch (error) {
        await failSync(syncId, error);
        throw error;
      }
    }
  });
}
