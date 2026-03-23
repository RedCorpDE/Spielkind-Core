import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => (value ?? 'true').toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: boolFromEnv,
  REGIONDO_PUBLIC_KEY: z.string().min(1),
  REGIONDO_PRIVATE_KEY: z.string().min(1),
  REGIONDO_BASE_URL: z.string().url(),
  REGIONDO_LANGUAGE: z.string().default('de-DE'),
  REGIONDO_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_BOOKINGS_PATH: z.string().default('/webhooks/regiondo/bookings'),
  WEBHOOK_AUTH_HEADER_NAME: z.string().optional(),
  WEBHOOK_AUTH_HEADER_VALUE: z.string().optional(),
  PRODUCT_SYNC_CRON: z.string().default('0 3 * * *')
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const appConfig = parsed.data;
