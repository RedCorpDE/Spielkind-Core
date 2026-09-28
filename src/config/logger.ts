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
      'headers.stripe-signature',
      'config.REGIONDO_SECRET_KEY',
      'config.STRIPE_SECRET_KEY',
      'config.STRIPE_WEBHOOK_SECRET',
      'config.REMINDER_PROVIDER_SECRET',
      'config.CRON_SECRET'
    ],
    remove: true
  }
});
