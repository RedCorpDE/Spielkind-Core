import cron from 'node-cron';
import { appConfig } from '../config/env.js';
import { logger } from '../config/logger.js';
import { internalJobDefinitions } from '../jobs/internal-job-registry.js';

let schedulerStarted = false;

function schedule(name: string, expression: string, run: () => Promise<unknown>) {
  cron.schedule(
    expression,
    () => {
      void run().catch((error) => {
        logger.error({ err: error, job: name }, 'Embedded scheduler job failed');
      });
    },
    {
      timezone: appConfig.SCHEDULER_TIMEZONE
    }
  );

  logger.info({ job: name, expression, timezone: appConfig.SCHEDULER_TIMEZONE }, 'Embedded scheduler job registered');
}

export function startEmbeddedScheduler(): void {
  if (!appConfig.ENABLE_EMBEDDED_SCHEDULER || schedulerStarted) {
    return;
  }

  schedulerStarted = true;

  for (const definition of internalJobDefinitions) {
    if (!definition.embeddedCron) {
      continue;
    }

    schedule(definition.jobType, definition.embeddedCron, async () => {
      await definition.run(definition.bodySchema.parse({}));
    });
  }
}
