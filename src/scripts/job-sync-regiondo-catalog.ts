import { logger } from '../config/logger.js';
import { runRegiondoCatalogSyncJob } from '../modules/regiondo/regiondo-catalog-sync.job.js';

runRegiondoCatalogSyncJob()
  .then((result) => {
    logger.info({ result }, 'Regiondo catalog sync job completed');
  })
  .catch((error) => {
    logger.error({ err: error }, 'Regiondo catalog sync job failed');
    process.exitCode = 1;
  });
