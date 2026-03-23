import { appConfig } from './config.js';
import { pool } from './db/client.js';
import { startDailyProductSync } from './scheduler.js';
import { createServer } from './server.js';

async function bootstrap(): Promise<void> {
  await pool.query('SELECT 1');
  console.log('Database connection established.');

  const app = createServer();
  app.listen(appConfig.PORT, () => {
    console.log(`Server listening on port ${appConfig.PORT}`);
  });

  startDailyProductSync();
}

bootstrap().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
