import { Pool } from 'pg';
import { appConfig } from '../config/env.js';
import { logger } from '../config/logger.js';

export const pool = new Pool({
  connectionString: appConfig.DATABASE_URL,
  ssl: appConfig.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected PostgreSQL pool error');
});

export async function checkDatabaseReadiness(): Promise<void> {
  await pool.query('SELECT 1');
}
