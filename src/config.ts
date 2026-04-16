import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => (value ?? 'true').toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const schema = z
  .object({
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
    PRODUCT_SYNC_CRON: z.string().default('0 3 * * *'),
    HEALTHCHECKS_PING_URL: z.string().url().optional()
  })
  .superRefine((value, ctx) => {
    const hasHeaderName = Boolean(value.WEBHOOK_AUTH_HEADER_NAME);
    const hasHeaderValue = Boolean(value.WEBHOOK_AUTH_HEADER_VALUE);
    const hasSignatureSecret = Boolean(value.REGIONDO_WEBHOOK_SECRET);

    if (hasHeaderName !== hasHeaderValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WEBHOOK_AUTH_HEADER_NAME and WEBHOOK_AUTH_HEADER_VALUE must either both be set or both be empty.'
      });
    }

    if (value.NODE_ENV === 'production' && !hasSignatureSecret && !hasHeaderValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'At least one webhook auth mechanism is required in production: REGIONDO_WEBHOOK_SECRET or WEBHOOK_AUTH_HEADER_NAME+WEBHOOK_AUTH_HEADER_VALUE.'
      });
    }

    try {
      const url = new URL(value.DATABASE_URL);
      const host = url.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

      if (value.NODE_ENV === 'production' && isLocalHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'DATABASE_URL points to localhost in production. In Render, link your PostgreSQL and use its connection string.'
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must be a valid URL.'
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const appConfig = parsed.data;
