import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  consumeEmailVerification, createClientSession, findClientLogin, registerClient,
  revokeClientSession, rotateClientSession
} from '../../client-api/auth.repository.js';
import { createClientAccessToken, createOpaqueToken } from '../../client-api/tokens.js';
import type { ClientProfile } from '../../client-api/types.js';
import { getClientProfile, listClientLocations } from '../../client-api/repository.js';
import { appConfig } from '../../config/env.js';
import { getRequestMetadata } from '../admin.js';
import { ConflictHttpError, HttpError, UnauthorizedHttpError, ValidationHttpError } from '../errors.js';
import { optionalWebClientAuth, requireWebClientAuth, requireWebServiceScope, type WebFastifyRequest } from '../web-auth.js';
import { getBookingOffering, getCatalogProduct, getCatalogProductOffering, listCatalogProducts } from '../../modules/catalog/catalog.repository.js';
import { verifyAvailabilityToken } from '../../modules/web/availability-token.js';
import { listWebAvailability } from '../../modules/web/web-availability.service.js';
import { createWebCheckout } from '../../modules/web/web-checkout.service.js';
import { resolveWebCheckoutIdentity } from '../../modules/web/web-checkout-identity.js';
import {
  canClientCancelBooking, cancelWebBooking, getOwnedWebBooking, getWebBooking,
  listWebClientBookings, webBookingStatus
} from '../../modules/web/web-booking.service.js';
import {
  bookingForManagementToken, ensureManagementToken, validateCheckoutToken
} from '../../modules/web/web-token.service.js';
import { bookingIntentSchema } from '../schemas/booking-intent.schema.js';
import { bookingQuoteService } from '../../modules/bookings/booking-quote.service.js';
import { createReservationHold } from '../../modules/availability/reservation-hold.service.js';
import { getVariantEligibility } from '../../modules/bookings/variant-eligibility.service.js';
import { getCancellationQuote } from '../../modules/cancellations/cancellation.service.js';

const uuid = z.string().uuid();
const email = z.string().trim().email().transform((value) => value.toLowerCase());
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(2).max(100).optional(), email, password: z.string().min(8).max(128)
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const bookingParams = z.object({ bookingId: uuid });
const productParams = z.object({ productId: uuid });
const managementParams = z.object({ token: z.string().min(32).max(512) });
const cancelSchema = z.object({ reason: z.string().trim().max(1000).optional() }).default({});
const checkoutSchema = z.object({
  locationId: uuid, productId: uuid, locationProductId: uuid.optional(), variantId: uuid.nullish(),
  availabilityId: z.string().min(20).max(4096).optional(),
  startAt: z.string().datetime().optional(), endAt: z.string().datetime().optional(),
  participants: z.coerce.number().int().positive().max(100).optional(),
  quantity: z.coerce.number().int().positive().max(100).default(1),
  durationMinutes: z.coerce.number().int().positive().max(7 * 24 * 60).optional(),
  options: z.array(z.object({
    optionId: uuid,
    value: z.string().trim().min(1).max(500).optional(),
    quantity: z.coerce.number().int().positive().max(100).optional()
  })).max(30).default([]),
  guest: z.unknown().optional(),
  // Accepted temporarily for older deployed WordPress bundles. It is never used
  // when a Core client session is authenticated.
  contact: z.unknown().optional()
}).superRefine((value, context) => {
  if (!value.availabilityId && !(value.locationProductId && value.startAt && value.endAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['availabilityId'], message: 'availabilityId or canonical booking times are required.' });
  }
});

const attempts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(request: FastifyRequest, bucket: string, limit: number, windowMs = 60_000): void {
  const key = `${bucket}:${request.ip}`;
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) throw new HttpError(429, 'Too many requests.', 'RATE_LIMITED');
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationHttpError(message);
  return parsed.data;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key'];
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ValidationHttpError('Idempotency-Key is required.');
  }
  return value.trim();
}

function sessionResponse(client: ClientProfile, sessionId: string, refreshToken: string) {
  const access = createClientAccessToken(client.id, sessionId);
  return { accessToken: access.token, refreshToken, expiresAt: access.expiresAt, client };
}

async function service(request: FastifyRequest, scope: Parameters<typeof requireWebServiceScope>[1]) {
  await requireWebServiceScope(request as WebFastifyRequest, scope);
}

export function safeWebProduct(product: Awaited<ReturnType<typeof getCatalogProduct>>) {
  if (!product) return null;
  return {
    id: product.id, title: product.title, description: product.description, imageUrl: product.imageUrl,
    price: product.price, variants: product.variants
  };
}

function safeWebOffering(product: Awaited<ReturnType<typeof getCatalogProductOffering>>) {
  if (!product) return null;
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
}

export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/web/locations', async (request) => {
    await service(request, 'locations:read');
    rateLimit(request, 'web-read', 120);
    const items = (await listClientLocations()).map((location) => ({
      id: location.id, name: location.name, address: location.address, city: location.city,
      postalCode: location.postalCode, countryCode: location.countryCode, lat: location.lat,
      lng: location.lng, description: location.description, imageUrls: location.imageUrls,
      directions: location.directions, parking: location.parking, publicTransport: location.publicTransport,
      facilities: location.facilities, houseRules: location.houseRules
    }));
    return { items };
  });

  app.get('/api/web/products', async (request) => {
    await service(request, 'products:read');
    rateLimit(request, 'web-read', 120);
    const query = parse(z.object({ locationId: uuid.optional() }), request.query, 'Invalid product query.');
    return { items: (await listCatalogProducts(query.locationId)).map(safeWebProduct) };
  });

  app.get('/api/web/products/:productId', async (request) => {
    await service(request, 'products:read');
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    const query = parse(z.object({ locationId: uuid.optional() }), request.query, 'Invalid product query.');
    const product = query.locationId
      ? safeWebOffering(await getCatalogProductOffering(productId, query.locationId))
      : safeWebProduct(await getCatalogProduct(productId));
    if (!product) throw new HttpError(404, 'Product was not found.', 'PRODUCT_NOT_FOUND');
    return product;
  });

  app.post('/api/web/booking-quotes', async (request) => {
    await service(request, 'availability:read');
    rateLimit(request, 'web-quote', 60);
    const body = parse(bookingIntentSchema, request.body, 'Invalid booking quote payload.');
    const auth = await optionalWebClientAuth(request as WebFastifyRequest);
    return bookingQuoteService.quote(body, { clientId: auth?.client.id });
  });

  app.post('/api/web/booking-holds', async (request) => {
    await service(request, 'checkout:create');
    rateLimit(request, 'web-hold', 20, 10 * 60_000);
    const body = parse(bookingIntentSchema, request.body, 'Invalid booking hold payload.');
    const offering = await getBookingOffering(body.locationProductId);
    if (!offering || !offering.active || offering.productId !== body.productId || offering.locationId !== body.locationId) {
      throw new HttpError(404, 'Offering was not found.', 'PRODUCT_NOT_FOUND');
    }
    const auth = await optionalWebClientAuth(request as WebFastifyRequest);
    const quote = await bookingQuoteService.quote(body, { clientId: auth?.client.id });
    if (!quote.available) throw new ConflictHttpError('The selection is no longer available.', 'AVAILABILITY_UNAVAILABLE');
    if (offering.bookingProvider !== 'core') {
      return { id: null, status: 'provider_managed' as const, expiresAt: quote.expiresAt };
    }
    return createReservationHold({
      clientId: auth?.client.id,
      locationId: body.locationId,
      productId: body.productId,
      productOfferingId: body.locationProductId,
      productVariantId: body.variantId,
      quantity: body.participants ?? body.quantities?.participants ?? 1,
      startsAt: quote.configuration.startAt,
      endsAt: quote.configuration.endAt,
      expiresAt: quote.expiresAt,
      idempotencyKey: `web:${idempotencyKey(request)}`,
      metadata: { source: 'wordpress', quoteId: quote.quoteId }
    });
  });

  app.get('/api/web/products/:productId/availability', async (request) => {
    await service(request, 'availability:read');
    rateLimit(request, 'web-availability', 60);
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    const query = parse(z.object({
      locationId: uuid, variantId: uuid.optional(), date: z.string().date().optional(),
      from: z.string().datetime().optional(), to: z.string().datetime().optional(),
      durationMinutes: z.coerce.number().int().positive().max(7 * 24 * 60).optional(),
      quantity: z.coerce.number().int().positive().max(100).default(1)
    }), request.query, 'Invalid availability query.');
    const result = await listWebAvailability({ productId, ...query, quantity: query.quantity ?? 1 });
    if (result === null) throw new HttpError(404, 'Product was not found.', 'PRODUCT_NOT_FOUND');
    return result;
  });

  app.post('/api/web/products/:productId/availability', async (request) => {
    await service(request, 'availability:read');
    rateLimit(request, 'web-availability', 60);
    const { productId } = parse(productParams, request.params, 'Invalid product id.');
    const body = parse(z.object({
      locationId: uuid,
      variantId: uuid.optional(),
      date: z.string().date().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      startDate: z.string().date().optional(),
      endDate: z.string().date().optional(),
      startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
      endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
      durationMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
      quantity: z.number().int().positive().max(100).default(1),
      options: z.array(z.object({
        optionId: uuid,
        value: z.string().trim().min(1).max(500).optional(),
        quantity: z.number().int().positive().max(100).optional()
      })).max(30).default([])
    }), request.body, 'Invalid availability request.');
    const result = await listWebAvailability({ productId, ...body, quantity: body.quantity ?? 1 });
    if (result === null) throw new HttpError(404, 'Product was not found.', 'PRODUCT_NOT_FOUND');
    const product = await getCatalogProductOffering(productId, body.locationId);
    const startsAt = result.items[0]?.startsAt ?? (body.startDate && body.startTime ? `${body.startDate}T${body.startTime}:00` : null);
    const variants = result.variants ?? (product?.bookingProvider === 'core' && startsAt
      ? await getVariantEligibility({
          productId,
          startsAt,
          timezone: product.bookingConfiguration.timeSelection.timezone
        })
      : []);
    return { ...result, variants };
  });

  app.post('/api/web/auth/login', async (request) => {
    await service(request, 'client-auth:proxy');
    rateLimit(request, 'web-auth', 10, 10 * 60_000);
    const body = parse(loginSchema, request.body, 'Invalid login payload.');
    const client = await findClientLogin(body.email);
    if (!client?.passwordHash || !(await bcrypt.compare(body.password, client.passwordHash))) {
      throw new UnauthorizedHttpError('Invalid email or password.', 'AUTH_INVALID');
    }
    const refreshToken = createOpaqueToken();
    const metadata = getRequestMetadata(request);
    const sessionId = await createClientSession({ clientId: client.id, identityId: client.identityId, refreshToken, ...metadata });
    const { identityId: _identityId, passwordHash: _passwordHash, ...profile } = client;
    return sessionResponse(profile, sessionId, refreshToken);
  });

  app.post('/api/web/auth/register', async (request, reply) => {
    await service(request, 'client-auth:proxy');
    rateLimit(request, 'web-auth', 5, 10 * 60_000);
    const body = parse(registerSchema, request.body, 'Invalid registration payload.');
    try {
      const registered = await registerClient({ ...body, displayName: body.displayName ?? `${body.firstName} ${body.lastName}` });
      const refreshToken = createOpaqueToken();
      const metadata = getRequestMetadata(request);
      const sessionId = await createClientSession({
        clientId: registered.client.id, identityId: registered.identityId, refreshToken, ...metadata
      });
      reply.status(201);
      return sessionResponse(registered.client, sessionId, refreshToken);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictHttpError('An account with this email already exists.', 'VALIDATION_ERROR');
      }
      throw error;
    }
  });

  app.post('/api/web/auth/refresh', async (request) => {
    await service(request, 'client-auth:proxy');
    rateLimit(request, 'web-auth', 20, 10 * 60_000);
    const body = parse(refreshSchema, request.body, 'Refresh token is missing.');
    const nextRefreshToken = createOpaqueToken();
    const auth = await rotateClientSession(body.refreshToken, nextRefreshToken);
    if (!auth) throw new UnauthorizedHttpError('Refresh token is invalid.', 'AUTH_INVALID');
    return sessionResponse(auth.client, auth.sessionId, nextRefreshToken);
  });

  app.post('/api/web/auth/logout', async (request, reply) => {
    await service(request, 'client-auth:proxy');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    await revokeClientSession(auth.sessionId);
    reply.status(204).send();
  });

  app.post('/api/web/auth/verify', async (request) => {
    await service(request, 'client-auth:proxy');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    const body = parse(verifySchema, request.body, 'Invalid verification code.');
    if (!(await consumeEmailVerification(auth.client.id, body.code))) {
      throw new ValidationHttpError('The verification code is invalid or expired.');
    }
    return { accepted: true };
  });

  app.get('/api/web/me', async (request) => {
    await service(request, 'client-auth:proxy');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    return getClientProfile(auth.client.id);
  });

  app.get('/api/web/me/bookings', async (request) => {
    await service(request, 'booking-management');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    return { items: await listWebClientBookings(auth.client.id) };
  });

  app.get('/api/web/me/bookings/:bookingId', async (request) => {
    await service(request, 'booking-management');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    const booking = await getOwnedWebBooking(auth.client.id, bookingId);
    if (!booking) throw new HttpError(404, 'Booking was not found.', 'BOOKING_NOT_OWNED');
    return booking;
  });

  app.get('/api/web/me/bookings/:bookingId/cancellation-quote', async (request) => {
    await service(request, 'booking-management');
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    if (!(await canClientCancelBooking(auth.client.id, bookingId))) {
      throw new HttpError(403, 'You cannot cancel this booking.', 'BOOKING_NOT_OWNED');
    }
    return getCancellationQuote(bookingId);
  });

  app.post('/api/web/me/bookings/:bookingId/cancel', async (request) => {
    await service(request, 'booking-management');
    rateLimit(request, 'web-cancel', 10, 10 * 60_000);
    const auth = await requireWebClientAuth(request as WebFastifyRequest);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    if (!(await canClientCancelBooking(auth.client.id, bookingId))) {
      throw new HttpError(403, 'You cannot cancel this booking.', 'BOOKING_NOT_OWNED');
    }
    const body = parse(cancelSchema, request.body ?? {}, 'Invalid cancellation request.');
    return cancelWebBooking({ bookingId, actorType: 'client', actorClientId: auth.client.id, reason: body?.reason });
  });

  app.post('/api/web/checkout', async (request, reply) => {
    await service(request, 'checkout:create');
    rateLimit(request, 'web-checkout', 10, 10 * 60_000);
    const body = parse(checkoutSchema, request.body, 'Invalid checkout payload.');
    const availability = body.availabilityId
      ? verifyAvailabilityToken(body.availabilityId)
      : {
          locationId: body.locationId,
          productId: body.productId,
          locationProductId: body.locationProductId,
          variantId: body.variantId ?? null,
          startsAt: body.startAt!,
          endsAt: body.endAt!,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        };
    if (!availability) throw new ConflictHttpError('Availability is invalid or expired.', 'AVAILABILITY_UNAVAILABLE');
    if (availability.locationId !== body.locationId || availability.productId !== body.productId ||
        availability.variantId !== (body.variantId ?? null)) {
      throw new ConflictHttpError('Availability does not match the checkout selection.', 'AVAILABILITY_UNAVAILABLE');
    }
    const auth = await optionalWebClientAuth(request as WebFastifyRequest);
    const identity = resolveWebCheckoutIdentity(auth?.client ?? null, body.guest ?? body.contact);
    const result = await createWebCheckout({
      ...body, quantity: body.participants ?? body.quantity ?? 1, variantId: body.variantId ?? undefined, availability,
      identity, idempotencyKey: idempotencyKey(request)
    });
    reply.status(201);
    return result;
  });

  app.get('/api/web/bookings/:bookingId/status', async (request) => {
    await service(request, 'booking-status:read');
    rateLimit(request, 'web-status', 60);
    const { bookingId } = parse(bookingParams, request.params, 'Invalid booking id.');
    const token = request.headers['x-checkout-token'];
    const checkoutSession = typeof token === 'string' ? await validateCheckoutToken(bookingId, token) : null;
    if (!checkoutSession) {
      throw new UnauthorizedHttpError('Checkout token is invalid or expired.', 'CHECKOUT_TOKEN_INVALID');
    }
    const auth = await optionalWebClientAuth(request as WebFastifyRequest);
    if (checkoutSession.authenticatedClientId && auth?.client.id !== checkoutSession.authenticatedClientId) {
      throw new UnauthorizedHttpError('Checkout belongs to a different or expired client session.', 'AUTH_INVALID');
    }
    const status = await webBookingStatus(bookingId);
    if (!status) throw new HttpError(404, 'Booking was not found.', 'BOOKING_NOT_FOUND');
    if (status.bookingStatus === 'confirmed' && status.paymentStatus === 'paid') {
      return checkoutSession.authenticatedClientId
        ? status
        : { ...status, managementToken: await ensureManagementToken(bookingId) };
    }
    return status;
  });

  app.get('/api/web/booking-management/:token', async (request) => {
    await service(request, 'booking-management');
    rateLimit(request, 'web-management', 30);
    const { token } = parse(managementParams, request.params, 'Invalid management token.');
    const bookingId = await bookingForManagementToken(token);
    if (!bookingId) throw new UnauthorizedHttpError('Management token is invalid or expired.', 'AUTH_INVALID');
    const booking = await getWebBooking(bookingId);
    if (!booking) throw new HttpError(404, 'Booking was not found.', 'BOOKING_NOT_FOUND');
    return booking;
  });

  app.get('/api/web/booking-management/:token/cancellation-quote', async (request) => {
    await service(request, 'booking-management');
    rateLimit(request, 'web-management', 30);
    const { token } = parse(managementParams, request.params, 'Invalid management token.');
    const bookingId = await bookingForManagementToken(token);
    if (!bookingId) throw new UnauthorizedHttpError('Management token is invalid or expired.', 'AUTH_INVALID');
    return getCancellationQuote(bookingId);
  });

  app.post('/api/web/booking-management/:token/cancel', async (request) => {
    await service(request, 'booking-management');
    rateLimit(request, 'web-cancel', 10, 10 * 60_000);
    const { token } = parse(managementParams, request.params, 'Invalid management token.');
    const bookingId = await bookingForManagementToken(token);
    if (!bookingId) throw new UnauthorizedHttpError('Management token is invalid or expired.', 'AUTH_INVALID');
    const body = parse(cancelSchema, request.body ?? {}, 'Invalid cancellation request.');
    return cancelWebBooking({ bookingId, actorType: 'guest', reason: body?.reason });
  });
}
