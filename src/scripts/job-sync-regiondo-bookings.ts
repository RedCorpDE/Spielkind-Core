import { logger } from '../config/logger.js';
import { runSyncRegiondoBookingsJob } from '../modules/regiondo/regiondo-booking-sync.job.js';

const full = process.argv.slice(2).includes('--full');

runSyncRegiondoBookingsJob({ full })
  .then((result) => {
    logger.info({ result }, 'Regiondo booking sync job completed');
  })
  .catch((error) => {
    logger.error({ err: error }, 'Regiondo booking sync job failed');
    process.exitCode = 1;
  });
