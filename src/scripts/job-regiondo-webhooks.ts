import { logger } from '../config/logger.js';
import { runProcessRegiondoWebhookInboxJob } from '../modules/regiondo/regiondo-webhook-inbox.job.js';

runProcessRegiondoWebhookInboxJob()
  .then((result) => {
    logger.info({ result }, 'Regiondo webhook inbox job completed');
  })
  .catch((error) => {
    logger.error({ err: error }, 'Regiondo webhook inbox job failed');
    process.exitCode = 1;
  });
