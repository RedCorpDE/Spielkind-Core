import { logger } from '../config/logger.js';
import { runSyncRegiondoBookingsJob } from '../modules/regiondo/regiondo-booking-sync.job.js';
import { parseRegiondoBookingSyncCliArgs } from '../modules/regiondo/regiondo-booking-sync.service.js';

let options;
try {
  options = parseRegiondoBookingSyncCliArgs(process.argv.slice(2));
} catch (error) {
  logger.error({ err: error }, 'Invalid Regiondo booking sync command');
  process.exitCode = 1;
}

const run = options ? runSyncRegiondoBookingsJob(options) : Promise.resolve(null);

run
  .then((result) => {
    if (result) {
      logger.info({ result }, 'Regiondo booking sync job completed');
    }
  })
  .catch((error) => {
    logger.error({ err: error }, 'Regiondo booking sync job failed');
    process.exitCode = 1;
  });
