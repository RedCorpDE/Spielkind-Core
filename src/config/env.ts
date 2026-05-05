import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

loadEnv();

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => (value ?? 'false').toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

function booleanSetting(defaultValue: boolean) {
  return z
    .string()
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['true', 'false']))
    .transform((value) => value === 'true');
}

const commaSeparatedOrigins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

function resolvePackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function applyLegacyEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };

  normalized.REGIONDO_SECRET_KEY ??= normalized.REGIONDO_PRIVATE_KEY;
  normalized.REGIONDO_PRIVATE_KEY ??= normalized.REGIONDO_SECRET_KEY;
  normalized.REGIONDO_CATALOG_SYNC_CRON ??= normalized.PRODUCT_SYNC_CRON;

  return normalized;
}

function applyTestDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = applyLegacyEnvAliases(env);
  const nodeEnv = normalized.NODE_ENV ?? 'development';

  normalized.NODE_ENV = nodeEnv;

  if (nodeEnv !== 'test') {
    return normalized;
  }

  normalized.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/core_test';
  normalized.PORT ??= '3000';
  normalized.DATABASE_SSL ??= 'false';
  normalized.REGIONDO_BASE_URL ??= 'https://api.regiondo.example/v1';
  normalized.REGIONDO_PUBLIC_KEY ??= 'test-public-key';
  normalized.REGIONDO_SECRET_KEY ??= 'test-secret-key';
  normalized.REGIONDO_PRIVATE_KEY ??= normalized.REGIONDO_SECRET_KEY;
  normalized.REGIONDO_PRODUCT_SUPPLIER_ID ??= 'supplier-1';
  normalized.REGIONDO_CURRENCY ??= 'EUR';
  normalized.REMINDER_PROVIDER_WEBHOOK_URL ??= 'https://provider.example/webhook';
  normalized.REMINDER_PROVIDER_SECRET ??= 'test-reminder-secret';
  normalized.CRON_SECRET ??= 'test-cron-secret';
  normalized.ENABLE_EMBEDDED_SCHEDULER ??= 'false';
  normalized.SCHEDULER_TIMEZONE ??= 'Europe/Berlin';
  normalized.ADMIN_ACCESS_TOKEN_SECRET ??= '0123456789abcdef0123456789abcdef';
  normalized.WEBHOOK_AUTH_HEADER_NAME ??= 'x-test-webhook-auth';
  normalized.WEBHOOK_AUTH_HEADER_VALUE ??= 'test-webhook-token';
  normalized.DASHBOARD_ALLOWED_ORIGIN ??= 'http://localhost:5173';
  return normalized;
}

const rawEnv = applyTestDefaults(process.env);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_VERSION: z.string().default(resolvePackageVersion()),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    DATABASE_SSL: booleanSetting(false),

    ENABLE_EMBEDDED_SCHEDULER: booleanSetting(true),
    SCHEDULER_TIMEZONE: z.string().default('Europe/Berlin'),
    CRON_SECRET: z.string().min(8),

    REGIONDO_BASE_URL: z.string().url(),
    REGIONDO_PUBLIC_KEY: z.string().min(1),
    REGIONDO_SECRET_KEY: z.string().min(1),
    REGIONDO_PRIVATE_KEY: z.string().min(1).optional(),
    REGIONDO_PRODUCT_SUPPLIER_ID: z.string().min(1),
    REGIONDO_LANGUAGE: z.string().default('de-DE'),
    REGIONDO_CURRENCY: z.string().default('EUR'),
    REGIONDO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    REGIONDO_REQUEST_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    REGIONDO_REQUEST_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).max(10_000).default(500),
    REGIONDO_REQUEST_THROTTLE_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
    REGIONDO_AVAILABILITY_RANGE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    REGIONDO_OPTION_SLOT_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
    REGIONDO_PRODUCT_DETAIL_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
    REGIONDO_VARIATION_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
    REGIONDO_WEBHOOK_SECRET: z.string().optional(),
    REGIONDO_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
    REGIONDO_WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    REGIONDO_WEBHOOK_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    REGIONDO_WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    REGIONDO_WEBHOOK_CRON: z.string().default('*/1 * * * *'),
    WEBHOOK_BOOKINGS_PATH: z.string().default('/webhooks/regiondo'),
    WEBHOOK_AUTH_HEADER_NAME: z.string().optional(),
    WEBHOOK_AUTH_HEADER_VALUE: z.string().optional(),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(262_144),

    REGIONDO_CATALOG_SYNC_CRON: z.string().default('0 3 * * 1'),
    REMINDER_DISPATCH_CRON: z.string().default('*/5 * * * *'),

    REMINDER_PROVIDER_WEBHOOK_URL: z.string().url(),
    REMINDER_PROVIDER_SECRET: z.string().min(1),

    DASHBOARD_ALLOWED_ORIGIN: commaSeparatedOrigins,
    ADMIN_ACCESS_TOKEN_SECRET: z.string().min(32),
    ADMIN_ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(60 * 24).default(15),
    ADMIN_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    ADMIN_REFRESH_COOKIE_NAME: z.string().min(1).default('spielkind_admin_refresh'),
    ADMIN_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(12).max(128).default(14),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
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
          'At least one Regiondo webhook auth mechanism is required in production: REGIONDO_WEBHOOK_SECRET or WEBHOOK_AUTH_HEADER_NAME + WEBHOOK_AUTH_HEADER_VALUE.'
      });
    }

    try {
      const url = new URL(value.DATABASE_URL);
      const host = url.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

      if (value.NODE_ENV === 'production' && isLocalHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DATABASE_URL points to localhost in production. Use the Render PostgreSQL connection string instead.'
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must be a valid URL.'
      });
    }

    if (value.NODE_ENV === 'production' && value.DASHBOARD_ALLOWED_ORIGIN.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DASHBOARD_ALLOWED_ORIGIN must be configured in production.'
      });
    }
  });

const parsed = schema.safeParse(rawEnv);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten());
  process.exit(1);
}

export const appConfig = {
  ...parsed.data,
  REGIONDO_PRIVATE_KEY: parsed.data.REGIONDO_PRIVATE_KEY ?? parsed.data.REGIONDO_SECRET_KEY
} as const;

export type AppConfig = typeof appConfig;
