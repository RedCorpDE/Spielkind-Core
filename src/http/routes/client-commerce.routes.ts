import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createReservationHold, releaseReservationHold } from '../../modules/availability/reservation-hold.service.js';
import { bookingProviderRegistry } from '../../modules/bookings/booking-provider.js';
import { getCancellationQuote, requestCancellation } from '../../modules/cancellations/cancellation.service.js';
import { getCatalogProductOffering, getExternalVariantReference, listCatalogProducts } from '../../modules/catalog/catalog.repository.js';
import { getAvailabilitySummary } from '../../modules/resources/availability.service.js';
import { getClientBooking } from '../../client-api/repository.js';
import { requireClientAuth, type ClientFastifyRequest } from '../client.js';
import { ConflictHttpError, HttpError, ValidationHttpError } from '../errors.js';
import { createStripeCheckout } from '../../modules/payments/payment-checkout.service.js';
import { bookingIntentSchema } from '../schemas/booking-intent.schema.js';
import { bookingQuoteService } from '../../modules/bookings/booking-quote.service.js';
import { getBookingOffering } from '../../modules/catalog/catalog.repository.js';

const uuid = z.string().uuid();
const productParams = z.object({ productId: uuid });
const holdParams = z.object({ holdId: uuid });
const bookingParams = z.object({ bookingId: uuid });

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
    const query = parse(z.object({ locationId: uuid }), request.query, 'A valid location is required.');
    const product = await getCatalogProductOffering(productId, query.locationId);
    if (!product) throw new HttpError(404, 'This product is not available at this location.');
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      imageUrl: product.imageUrl,
      price: product.price,
      variants: product.variants,
      offering: product.offering,
      bookingConfiguration: product.bookingConfiguration
    };
  });

  app.get('/api/client/products/:productId/availability', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    const query = parse(
      z.object({ locationId: uuid, variantId: uuid.optional(), start: z.string().datetime(), end: z.string().datetime(), quantity: z.coerce.number().int().positive().max(100).default(1) }),
      request.query,
      'Invalid availability query.'
    );
    const product = await getCatalogProductOffering(productId, query.locationId);
    if (!product) throw new HttpError(404, 'This product is not available at this location.');
    const provider = bookingProviderRegistry.get(product.bookingProvider);
    if (provider.key === 'regiondo') {
      if (!query.variantId || !provider.getAvailability) throw new ValidationHttpError('A variant is required for Regiondo availability.');
      const externalVariantId = await getExternalVariantReference(query.variantId);
      if (!externalVariantId) throw new HttpError(409, 'The selected variant is not linked to Regiondo.');
      const slots = await provider.getAvailability({ externalVariantId, start: query.start, end: query.end, quantity: query.quantity ?? 1 });
      return { available: slots.length > 0, capacity: null, reserved: null, held: null, remaining: null, maxBookableQuantity: null, slots };
    }
    const availability = await getAvailabilitySummary({
      product_id: productId, product_variant_id: query.variantId, location_id: query.locationId,
      dt_from: query.start, dt_to: query.end, guest_count: query.quantity ?? 1
    });
    return {
      available: availability.available,
      capacity: availability.capacity,
      reserved: availability.reserved,
      held: availability.held,
      remaining: availability.remaining,
      maxBookableQuantity: availability.maxBookableQuantity
    };
  });

  app.post('/api/client/booking-quotes', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parse(bookingIntentSchema, request.body, 'Invalid booking quote request.');
    return bookingQuoteService.quote(input, { clientId: auth.client.id });
  });

  const createClientBookingHold = async (request: FastifyRequest) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const body = parse(bookingIntentSchema, request.body, 'Invalid reservation hold request.');
    const offering = await getBookingOffering(body.locationProductId);
    if (!offering || offering.productId !== body.productId || offering.locationId !== body.locationId || !offering.active) {
      throw new HttpError(404, 'This offering is not available at this location.');
    }
    const quote = await bookingQuoteService.quote(body, { clientId: auth.client.id });
    if (!quote.available) throw new ConflictHttpError('The selected time is no longer available.');
    if (offering.bookingProvider !== 'core') {
      return {
        id: null,
        status: 'provider_managed' as const,
        expiresAt: quote.expiresAt
      };
    }
    return createReservationHold({
      clientId: auth.client.id,
      locationId: body.locationId,
      productId: body.productId,
      productOfferingId: body.locationProductId,
      productVariantId: body.variantId,
      quantity: body.participants ?? body.quantities?.participants ?? 1,
      startsAt: body.startAt,
      endsAt: body.endAt,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      idempotencyKey: requireIdempotencyKey(request)
    });
  };

  app.post('/api/client/booking-holds', createClientBookingHold);
  app.post('/api/client/reservation-holds', createClientBookingHold);

  app.delete('/api/client/reservation-holds/:holdId', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { holdId } = parse(holdParams, request.params, 'Invalid reservation hold id.');
    if (!(await releaseReservationHold(holdId, auth.client.id))) throw new HttpError(404, 'Active reservation hold was not found.');
    reply.status(204).send();
  });

  app.post('/api/client/bookings', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const body = parse(bookingIntentSchema.and(z.object({ holdId: uuid.optional() })), request.body, 'Invalid booking request.');
    const offering = await getBookingOffering(body.locationProductId);
    if (!offering || !offering.active || offering.productId !== body.productId || offering.locationId !== body.locationId) {
      throw new HttpError(404, 'This offering is not available at this location.');
    }
    const quote = await bookingQuoteService.quote(body, { clientId: auth.client.id });
    if (!quote.available) throw new ConflictHttpError('The selected time is no longer available.');
    if (offering.bookingProvider === 'core' && !body.holdId) {
      throw new ValidationHttpError('A reservation hold is required for a Core booking.');
    }
    const provider = bookingProviderRegistry.get(offering.bookingProvider);
    if (!provider.createBooking) throw new ConflictHttpError(`${provider.displayName} booking creation is unavailable.`);
    const result = await provider.createBooking({
      intent: body,
      clientId: auth.client.id,
      holdId: body.holdId,
      idempotencyKey: requireIdempotencyKey(request),
      source: 'app'
    });
    reply.status(result.created ? 201 : 200);
    return { ...result, paymentRequired: offering.bookingProvider === 'core' };
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

