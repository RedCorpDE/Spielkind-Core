import { logger } from '../config/logger.js';
import { runDispatchRemindersJob } from '../modules/reminders/dispatch-reminders.job.js';

runDispatchRemindersJob()
  .then((result) => {
    logger.info({ result }, 'Reminder dispatch job completed');
  })
  .catch((error) => {
    logger.error({ err: error }, 'Reminder dispatch job failed');
    process.exitCode = 1;
  });
