import { pathToFileURL } from 'node:url';
import { appConfig } from './config/env.js';
import { logger } from './config/logger.js';
import { checkDatabaseReadiness } from './db/pool.js';
import { createApp } from './app.js';
import { startEmbeddedScheduler } from './scheduler/embedded-scheduler.js';

export async function startServer(): Promise<void> {
  await checkDatabaseReadiness();
  const app = createApp();

  await app.listen({
    host: '0.0.0.0',
    port: appConfig.PORT
  });

  logger.info({ port: appConfig.PORT }, 'Core API listening');
  startEmbeddedScheduler();
}

const isMainModule = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMainModule) {
  startServer().catch((error) => {
    logger.error({ err: error }, 'Fatal startup error');
    process.exit(1);
  });
}
