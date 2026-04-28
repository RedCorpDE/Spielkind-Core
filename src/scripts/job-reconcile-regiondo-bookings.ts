import { logger } from '../config/logger.js';
import { runReconcileRegiondoBookingsJob } from '../modules/bookings/reconcile-regiondo-bookings.job.js';

runReconcileRegiondoBookingsJob()
  .then((result) => {
    logger.info({ result }, 'Regiondo reconciliation job completed');
  })
  .catch((error) => {
    logger.error({ err: error }, 'Regiondo reconciliation job failed');
    process.exitCode = 1;
  });
