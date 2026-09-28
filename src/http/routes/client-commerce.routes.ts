import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createReservationHold, releaseReservationHold } from '../../modules/availability/reservation-hold.service.js';
import { bookingProviderRegistry } from '../../modules/bookings/booking-provider.js';
import { createNativeBooking } from '../../modules/bookings/native-booking.service.js';
import { getCancellationQuote, requestCancellation } from '../../modules/cancellations/cancellation.service.js';
import { getCatalogProduct, getExternalVariantReference, listCatalogProducts } from '../../modules/catalog/catalog.repository.js';
import { pricingService } from '../../modules/pricing/pricing.service.js';
import { getAvailabilitySummary } from '../../modules/resources/availability.service.js';
import { getClientBooking } from '../../client-api/repository.js';
import { requireClientAuth, type ClientFastifyRequest } from '../client.js';
import { ConflictHttpError, HttpError, ValidationHttpError } from '../errors.js';
import { createStripeCheckout } from '../../modules/payments/payment-checkout.service.js';

const uuid = z.string().uuid();
const productParams = z.object({ productId: uuid });
const holdParams = z.object({ holdId: uuid });
const bookingParams = z.object({ bookingId: uuid });
const optionSchema = z.object({ optionId: uuid, value: z.string().trim().min(1).max(500) });
const quoteSchema = z.object({
  productId: uuid,
  locationId: uuid.optional(),
  variantId: uuid.optional(),
  options: z.array(optionSchema).max(30).default([]),
  quantity: z.number().int().positive().max(100),
  discountCode: z.string().trim().min(1).max(100).optional()
});
const scheduleSchema = z.object({
  locationId: uuid,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime()
}).refine((value) => new Date(value.endsAt) > new Date(value.startsAt), { message: 'endsAt must be after startsAt.' });

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationHttpError(message);
  return result.data;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['x-idempotency-key'];
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ValidationHttpError('A valid x-idempotency-key header is required.');
  }
  return value.trim();
}

async function requireOwnedBooking(clientId: string, bookingId: string): Promise<void> {
  if (!(await getClientBooking(clientId, bookingId))) throw new HttpError(404, 'Booking was not found.');
}

export async function registerClientCommerceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/products', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    const query = parse(z.object({ locationId: uuid.optional() }), request.query, 'Invalid product query.');
    return { items: await listCatalogProducts(query.locationId) };
  });

  app.get('/api/client/products/:productId', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    return (await getCatalogProduct(productId)) ?? (() => { throw new HttpError(404, 'Product was not found.'); })();
  });

  app.get('/api/client/products/:productId/availability', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    const query = parse(
      z.object({ locationId: uuid, variantId: uuid.optional(), start: z.string().datetime(), end: z.string().datetime(), quantity: z.coerce.number().int().positive().max(100).default(1) }),
      request.query,
      'Invalid availability query.'
    );
    const product = await getCatalogProduct(productId);
    if (!product) throw new HttpError(404, 'Product was not found.');
    const provider = bookingProviderRegistry.get(product.bookingProvider);
    if (provider.key === 'regiondo') {
      if (!query.variantId || !provider.getAvailability) throw new ValidationHttpError('A variant is required for Regiondo availability.');
      const externalVariantId = await getExternalVariantReference(query.variantId);
      if (!externalVariantId) throw new HttpError(409, 'The selected variant is not linked to Regiondo.');
      const slots = await provider.getAvailability({ externalVariantId, start: query.start, end: query.end, quantity: query.quantity ?? 1 });
      return { available: slots.length > 0, capacity: null, reserved: null, held: null, remaining: null, maxBookableQuantity: null, slots };
    }
    return getAvailabilitySummary({
      product_id: productId, location_id: query.locationId, dt_from: query.start, dt_to: query.end, guest_count: query.quantity ?? 1
    });
  });

  app.post('/api/client/booking-quotes', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parse(quoteSchema, request.body, 'Invalid booking quote request.');
    return pricingService.quote({ ...input, clientId: auth.client.id });
  });

  app.post('/api/client/reservation-holds', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const body = parse(quoteSchema.and(scheduleSchema), request.body, 'Invalid reservation hold request.');
    const product = await getCatalogProduct(body.productId);
    if (!product) throw new HttpError(404, 'Product was not found.');
    if (product.bookingProvider !== 'core') throw new ConflictHttpError('Reservation holds are currently created by Regiondo for this product.');
    return createReservationHold({
      clientId: auth.client.id,
      locationId: body.locationId,
      productId: body.productId,
      productVariantId: body.variantId,
      quantity: body.quantity,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      idempotencyKey: requireIdempotencyKey(request)
    });
  });

  app.delete('/api/client/reservation-holds/:holdId', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { holdId } = parse(holdParams, request.params, 'Invalid reservation hold id.');
    if (!(await releaseReservationHold(holdId, auth.client.id))) throw new HttpError(404, 'Active reservation hold was not found.');
    reply.status(204).send();
  });

  app.post('/api/client/bookings', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const body = parse(quoteSchema.and(scheduleSchema).and(z.object({ holdId: uuid })), request.body, 'Invalid booking request.');
    const result = await createNativeBooking({
      ...body,
      clientId: auth.client.id,
      idempotencyKey: requireIdempotencyKey(request)
    });
    reply.status(result.created ? 201 : 200);
    return result;
  });

  app.get('/api/client/bookings/:bookingId/cancellation-quote', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    await requireOwnedBooking(auth.client.id, bookingId);
    return getCancellationQuote(bookingId);
  });

  app.post('/api/client/bookings/:bookingId/cancel', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    await requireOwnedBooking(auth.client.id, bookingId);
    return requestCancellation(bookingId);
  });

  app.post('/api/client/bookings/:bookingId/checkout', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    await requireOwnedBooking(auth.client.id, bookingId);
    return createStripeCheckout({
      bookingId,
      clientId: auth.client.id,
      idempotencyKey: requireIdempotencyKey(request)
    });
  });
}

