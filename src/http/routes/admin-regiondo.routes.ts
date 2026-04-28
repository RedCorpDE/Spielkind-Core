import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest, requireAdminAuth } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import { getRegiondoSyncSummary, getRegiondoWebhookEvent, listRegiondoWebhookEvents } from '../../sync/repository.js';
import { retryBookingWebhookEvent } from '../../sync/sync-service.js';
import { runProcessRegiondoWebhookInboxJob } from '../../modules/regiondo/regiondo-webhook-inbox.job.js';

const regiondoWebhookEventStatusSchema = z.enum(['pending', 'processing', 'retrying', 'processed', 'dead_letter']);

const listRegiondoWebhookEventsQuerySchema = z.object({
  status: regiondoWebhookEventStatusSchema.optional(),
  bookingKey: z.string().trim().optional(),
  orderNumber: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

export async function registerAdminRegiondoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/regiondo/sync-summary', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { ok: true, item: await getRegiondoSyncSummary() };
  });

  app.get('/api/admin/regiondo/webhook-events', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = listRegiondoWebhookEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid Regiondo webhook events query.');
    }

    return { ok: true, ...(await listRegiondoWebhookEvents(parsed.data)) };
  });

  app.get('/api/admin/regiondo/webhook-events/:eventId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const { eventId } = request.params as { eventId: string };
    const event = await getRegiondoWebhookEvent(eventId);
    if (!event) {
      throw new HttpError(404, 'Regiondo webhook event not found.');
    }

    return { ok: true, item: event };
  });

  app.post('/api/admin/regiondo/webhook-events/:eventId/retry', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
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
