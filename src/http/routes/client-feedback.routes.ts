import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createBookingFeedbackSchema } from '../../modules/feedback/feedback.schemas.js';
import {
  readClientBookingFeedback,
  submitClientBookingFeedback
} from '../../modules/feedback/feedback.service.js';
import { requireClientAuth, type ClientFastifyRequest } from '../client.js';
import { ValidationHttpError } from '../errors.js';

const bookingParamsSchema = z.object({ bookingId: z.string().uuid() });

export async function registerClientFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/bookings/:bookingId/feedback', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const params = bookingParamsSchema.safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid booking id.');
    return readClientBookingFeedback(params.data.bookingId, auth.client.id);
  });

  app.post('/api/client/bookings/:bookingId/feedback', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const params = bookingParamsSchema.safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid booking id.');
    const input = createBookingFeedbackSchema.safeParse(request.body);
    if (!input.success) throw new ValidationHttpError('Invalid feedback payload.');
    const feedback = await submitClientBookingFeedback(params.data.bookingId, auth.client.id, input.data);
    reply.code(201);
    return { feedback, eligible: false };
  });
}
