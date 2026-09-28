import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminFeedbackListQuerySchema,
  feedbackStatsQuerySchema
} from '../../modules/feedback/feedback.schemas.js';
import {
  getAdminFeedback,
  getFeedbackStats,
  listAdminFeedback,
  listLocationFeedbackSummaries
} from '../../modules/feedback/feedback.repository.js';
import { requireAdminPermission } from '../access-control.js';
import type { AdminFastifyRequest } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';

const feedbackIdSchema = z.object({ feedbackId: z.string().uuid() });

export async function registerAdminFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/feedback/stats', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const query = feedbackStatsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid feedback statistics query.');
    return { item: await getFeedbackStats(query.data) };
  });

  app.get('/api/admin/feedback/location-summaries', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const query = feedbackStatsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid location feedback statistics query.');
    const { locationId: _locationId, clientId: _clientId, bookingId: _bookingId, ...filters } = query.data;
    return { items: await listLocationFeedbackSummaries(filters) };
  });

  app.get('/api/admin/feedback', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const query = adminFeedbackListQuerySchema.safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid feedback query.');
    return { items: await listAdminFeedback(query.data) };
  });

  app.get('/api/admin/feedback/:feedbackId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const params = feedbackIdSchema.safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid feedback id.');
    const feedback = await getAdminFeedback(params.data.feedbackId);
    if (!feedback) throw new HttpError(404, 'Feedback was not found.');
    return { item: feedback };
  });

  app.get('/api/admin/clients/:clientId/feedback', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const params = z.object({ clientId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid client id.');
    const query = adminFeedbackListQuerySchema.safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid feedback query.');
    return { items: await listAdminFeedback({ ...query.data, clientId: params.data.clientId }) };
  });

  app.get('/api/admin/bookings/:bookingId/feedback', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'feedback', 'view');
    const params = z.object({ bookingId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid booking id.');
    const items = await listAdminFeedback({ bookingId: params.data.bookingId, limit: 200 });
    return { items };
  });
}
