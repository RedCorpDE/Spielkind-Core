import pino from 'pino';
import { appConfig } from './env.js';

export const logger = pino({
  level: appConfig.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'headers.x-api-hash',
      'headers.x-core-signature',
      'config.REGIONDO_SECRET_KEY',
      'config.REGIONDO_PRIVATE_KEY',
      'config.REMINDER_PROVIDER_SECRET',
      'config.CRON_SECRET'
    ],
    remove: true
  }
});
