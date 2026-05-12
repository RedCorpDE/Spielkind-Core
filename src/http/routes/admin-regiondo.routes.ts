import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import {
  RegiondoApiError,
  RegiondoAuthError,
  RegiondoRateLimitError,
  RegiondoTransientError
} from '../../modules/regiondo/regiondo.client.js';
import { runSyncRegiondoBookingsJob } from '../../modules/regiondo/regiondo-booking-sync.job.js';
import { getRegiondoSyncSummary, getRegiondoWebhookEvent, listRegiondoWebhookEvents } from '../../sync/repository.js';
import { retryBookingWebhookEvent } from '../../sync/sync-service.js';
import { runProcessRegiondoWebhookInboxJob } from '../../modules/regiondo/regiondo-webhook-inbox.job.js';

const regiondoWebhookEventStatusSchema = z.enum(['pending', 'processing', 'retrying', 'processed', 'dead_letter']);
const regiondoBookingSyncBodySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).optional()
  })
  .default({});

const listRegiondoWebhookEventsQuerySchema = z.object({
  status: regiondoWebhookEventStatusSchema.optional(),
  bookingKey: z.string().trim().optional(),
  orderNumber: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

function getRegiondoSyncStatusCode(error: RegiondoApiError): number {
  if (error instanceof RegiondoRateLimitError) {
    return 429;
  }

  if (error instanceof RegiondoTransientError) {
    return 503;
  }

  if (error instanceof RegiondoAuthError) {
    return 502;
  }

  return 502;
}

export async function registerAdminRegiondoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/regiondo/sync-summary', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'view');
    return { ok: true, item: await getRegiondoSyncSummary() };
  });

  app.post('/api/admin/regiondo/sync-bookings', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'manage');
    const parsed = regiondoBookingSyncBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid Regiondo booking sync payload.');
    }

    try {
      const job = await runSyncRegiondoBookingsJob(parsed.data);

      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.regiondo.sync_bookings',
        entityType: 'sync',
        details: job.metadata
      });

      return { ok: true, job };
    } catch (error) {
      if (error instanceof RegiondoApiError) {
        const details = error.responseBody?.trim();

        return reply.status(getRegiondoSyncStatusCode(error)).send({
          ok: false,
          error: error.message,
          ...(details ? { details } : {})
        });
      }

      throw error;
    }
  });

  app.get('/api/admin/regiondo/webhook-events', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'view');
    const parsed = listRegiondoWebhookEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid Regiondo webhook events query.');
    }

    return { ok: true, ...(await listRegiondoWebhookEvents(parsed.data)) };
  });

  app.get('/api/admin/regiondo/webhook-events/:eventId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'view');
    const { eventId } = request.params as { eventId: string };
    const event = await getRegiondoWebhookEvent(eventId);
    if (!event) {
      throw new HttpError(404, 'Regiondo webhook event not found.');
    }

    return { ok: true, item: event };
  });

  app.post('/api/admin/regiondo/webhook-events/:eventId/retry', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'manage');
    const { eventId } = request.params as { eventId: string };
    await retryBookingWebhookEvent(eventId);
    const job = await runProcessRegiondoWebhookInboxJob({ limit: 1 });

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.regiondo.webhook_event.retried',
      entityType: 'regiondo_webhook_event',
      entityId: eventId,
      details: { job }
    });

    return { ok: true, job, item: await getRegiondoWebhookEvent(eventId) };
  });
}
