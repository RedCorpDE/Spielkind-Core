import { Pool } from 'pg';
import { appConfig } from '../config.js';

export const pool = new Pool({
  connectionString: appConfig.DATABASE_URL,
  ssl: appConfig.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});
