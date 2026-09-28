import type { FastifyInstance, FastifyRequest } from 'fastify';
import { appConfig } from '../../config/env.js';
import { ProviderUnavailableError } from '../../modules/bookings/booking.errors.js';
import { verifyStripeWebhookSignature, StripeSignatureError } from '../../modules/integrations/payment-providers/stripe/stripe-signature.js';
import { stripeEventSchema } from '../../modules/integrations/payment-providers/stripe/stripe-webhook.processor.js';
import { enqueueStripeWebhook } from '../../modules/integrations/payment-providers/stripe/stripe-webhook.repository.js';
import { UnauthorizedHttpError, ValidationHttpError } from '../errors.js';

export async function registerStripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/stripe', async (request, reply) => {
    if (!appConfig.STRIPE_WEBHOOK_SECRET) throw new ProviderUnavailableError('Stripe webhooks are not configured.');
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') throw new UnauthorizedHttpError('Stripe signature is required.');
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
    if (!rawBody) throw new ValidationHttpError('Raw Stripe webhook body is required.');
    try {
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader: signature,
        secret: appConfig.STRIPE_WEBHOOK_SECRET,
        toleranceSeconds: appConfig.STRIPE_WEBHOOK_TOLERANCE_SECONDS
      });
    } catch (error) {
      if (error instanceof StripeSignatureError) throw new UnauthorizedHttpError(error.message);
      throw error;
    }
    const parsed = stripeEventSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid Stripe event payload.');
    const result = await enqueueStripeWebhook({
      externalEventId: parsed.data.id,
      eventType: parsed.data.type,
      payload: parsed.data,
      headers: request.headers
    });
    reply.status(result.inserted ? 202 : 200);
    return { received: true, duplicate: !result.inserted };
  });
}
