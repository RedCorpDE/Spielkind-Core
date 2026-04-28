import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { startSync, finishSync, failSync } from '../../sync/sync-log.js';
import { regiondoClient } from './regiondo.client.js';
import { upsertRegiondoCatalogProduct, upsertSyncState } from './regiondo-catalog.repository.js';

export async function runRegiondoCatalogSyncJob() {
  return runJobWithLock({
    jobType: JOB_TYPES.SYNC_REGIONDO_CATALOG,
    handler: async () => {
      const syncId = await startSync('regiondo_catalog');

      try {
        const products = await regiondoClient.getCatalogProducts();

        for (const product of products) {
          await upsertRegiondoCatalogProduct(product);
        }

        await upsertSyncState({
          syncType: 'regiondo_catalog',
          metadata: {
            productCount: products.length
          }
        });
        await finishSync(syncId, products.length);

        return {
          recordsProcessed: products.length,
          metadata: { productCount: products.length }
        };
      } catch (error) {
        await failSync(syncId, error);
        throw error;
      }
    }
  });
}
