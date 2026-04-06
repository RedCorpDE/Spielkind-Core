import { appConfig } from './config.js';
import { pool } from './db/client.js';
import { startDailyProductSync, registerOutboundJobs } from './scheduler.js';
import { runStartupCatchup } from './outbound/startup-catchup.js';
import { createServer } from './server.js';

async function bootstrap(): Promise<void> {
  await pool.query('SELECT 1');
  console.log('Database connection established.');

  const app = createServer();
  app.listen(appConfig.PORT, () => {
    console.log(`Server listening on port ${appConfig.PORT}`);
  });

  startDailyProductSync();
  registerOutboundJobs();

  // Run once at startup to recover any events missed during downtime
  await runStartupCatchup();
}

bootstrap().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
