import { z } from 'zod';
import { appConfig } from '../config/env.js';
import { runReconcileRegiondoBookingsJob } from '../modules/bookings/reconcile-regiondo-bookings.job.js';
import { runSyncRegiondoBookingsJob } from '../modules/regiondo/regiondo-booking-sync.job.js';
import { runDispatchRemindersJob } from '../modules/reminders/dispatch-reminders.job.js';
import { runRegiondoCatalogSyncJob } from '../modules/regiondo/regiondo-catalog-sync.job.js';
import { runProcessRegiondoWebhookInboxJob } from '../modules/regiondo/regiondo-webhook-inbox.job.js';
import { JOB_TYPES, type JobResult, type JobType } from './job-types.js';

export const INTERNAL_JOB_ROUTE_PREFIX = '/internal/jobs';

const emptyBodySchema = z.object({}).strict().default({});
const limitBodySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).optional()
  })
  .default({});

export interface InternalJobDefinition<TBodySchema extends z.ZodTypeAny = z.ZodTypeAny> {
  routePath: string;
  jobType: JobType;
  description: string;
  embeddedCron?: string;
  bodySchema: TBodySchema;
  run: (body: z.output<TBodySchema>) => Promise<JobResult>;
}

function defineInternalJob<TBodySchema extends z.ZodTypeAny>(
  definition: InternalJobDefinition<TBodySchema>
): InternalJobDefinition<TBodySchema> {
  return definition;
}

export const internalJobDefinitions = [
  defineInternalJob({
    routePath: 'process-regiondo-webhooks',
    jobType: JOB_TYPES.PROCESS_REGIONDO_WEBHOOKS,
    description: 'Processes queued Regiondo webhook events.',
    embeddedCron: appConfig.REGIONDO_WEBHOOK_CRON,
    bodySchema: limitBodySchema,
    run: async (body) => runProcessRegiondoWebhookInboxJob({ limit: body.limit })
  }),
  defineInternalJob({
    routePath: 'sync-regiondo-bookings',
    jobType: JOB_TYPES.SYNC_REGIONDO_BOOKINGS,
    description: 'Pulls recent Regiondo supplier bookings into the canonical booking dashboard.',
    embeddedCron: appConfig.REGIONDO_BOOKING_SYNC_CRON,
    bodySchema: limitBodySchema,
    run: async (body) => runSyncRegiondoBookingsJob({ limit: body.limit })
  }),
  defineInternalJob({
    routePath: 'sync-regiondo-catalog',
    jobType: JOB_TYPES.SYNC_REGIONDO_CATALOG,
    description: 'Loads Regiondo products, variations, and options into the local catalog tables.',
    embeddedCron: appConfig.REGIONDO_CATALOG_SYNC_CRON,
    bodySchema: emptyBodySchema,
    run: async () => runRegiondoCatalogSyncJob()
  }),
  defineInternalJob({
    routePath: 'dispatch-reminders',
    jobType: JOB_TYPES.DISPATCH_REMINDERS,
    description: 'Dispatches due reminder deliveries.',
    embeddedCron: appConfig.REMINDER_DISPATCH_CRON,
    bodySchema: limitBodySchema,
    run: async (body) => runDispatchRemindersJob({ limit: body.limit })
  }),
  defineInternalJob({
    routePath: 'reconcile-regiondo-bookings',
    jobType: JOB_TYPES.RECONCILE_REGIONDO_BOOKINGS,
    description: 'Reconciles Regiondo bookings against canonical booking snapshots.',
    embeddedCron: '15 */6 * * *',
    bodySchema: limitBodySchema,
    run: async (body) => runReconcileRegiondoBookingsJob({ limit: body.limit })
  })
] as const;
