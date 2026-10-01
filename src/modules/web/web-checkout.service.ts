import { createHash } from 'node:crypto';
import { appConfig } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { createReservationHold } from '../availability/reservation-hold.service.js';
import { bookingProviderRegistry } from '../bookings/booking-provider.js';
import { bookingQuoteService } from '../bookings/booking-quote.service.js';
import { getBookingOffering, getCatalogProductOffering } from '../catalog/catalog.repository.js';
import { paymentProviderRegistry } from '../payments/payment-provider.registry.js';
import { createCheckoutToken } from './web-token.service.js';
import type { WebAvailabilityTokenPayload } from './availability-token.js';

export interface WebCheckoutInput {
  clientId?: string;
  locationId: string;
  productId: string;
  variantId?: string;
  quantity: number;
  durationMinutes?: number;
  options?: Array<{ optionId: string; value?: string; quantity?: number }>;
  contact: { firstName: string; lastName: string; email: string; phone?: string };
  availability: WebAvailabilityTokenPayload;
  idempotencyKey: string;
}

export interface WebCheckoutResult {
  bookingId: string;
  checkoutSessionToken: string;
  clientSecret: string;
  expiresAt: string;
}

function requestHash(input: WebCheckoutInput): string {
  return createHash('sha256').update(JSON.stringify({
    locationId: input.locationId,
    productId: input.productId,
    variantId: input.variantId ?? null,
    quantity: input.quantity,
    durationMinutes: input.durationMinutes ?? null,
    options: input.options ?? [],
    contact: input.contact,
    availability: input.availability
  })).digest('hex');
}

async function resolveGuestClient(input: WebCheckoutInput['contact']): Promise<string> {
  const result = await pool.query<{ client_id: string }>(
    `INSERT INTO clients (first_name, last_name, display_name, email, phone_number)
     VALUES ($1, $2, NULLIF(TRIM(CONCAT_WS(' ', $1, $2)), ''), $3, $4)
     RETURNING client_id`,
    [input.firstName.trim(), input.lastName.trim(), input.email.trim().toLowerCase(), input.phone?.trim() || null]
  );
  return result.rows[0].client_id;
}

async function existingCheckout(key: string, hash: string): Promise<{
  bookingId: string; clientId: string; locationId: string; productId: string; paymentId: string; amountMinor: number;
  currency: string; description: string; email: string | null; expiresAt: string;
} | null> {
  const result = await pool.query<{
    booking_id: string; client_id: string; location_id: string; product_id: string; provider_payment_id: string;
    amount_minor: string | number; currency: string; description: string; email: string | null; expires_at: string;
    request_hash: string;
  }>(
    `SELECT booking.booking_id, booking.client_id, booking.location_id, item.product_id,
            payment.provider_payment_id, payment.amount_minor, payment.currency,
            item.product_name_snapshot AS description, client.email::text AS email,
            booking.reservation_expires_at AS expires_at, idem.request_hash
     FROM web_checkout_idempotency idem
     INNER JOIN bookings booking ON booking.booking_id = idem.booking_id
     INNER JOIN clients client ON client.client_id = booking.client_id
     INNER JOIN booking_items item ON item.booking_id = booking.booking_id
     INNER JOIN payments payment ON payment.booking_id = booking.booking_id AND payment.provider = 'stripe'
     WHERE idem.idempotency_key = $1 ORDER BY payment.created_at DESC LIMIT 1`,
    [key]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.request_hash !== hash) throw new Error('Idempotency key belongs to a different checkout request.');
  return {
    bookingId: row.booking_id, clientId: row.client_id, locationId: row.location_id, productId: row.product_id,
    paymentId: row.provider_payment_id, amountMinor: Number(row.amount_minor), currency: row.currency,
    description: row.description, email: row.email, expiresAt: row.expires_at
  };
}

export async function createWebCheckout(input: WebCheckoutInput): Promise<WebCheckoutResult> {
  const hash = requestHash(input);
  const prior = await existingCheckout(input.idempotencyKey, hash);
  if (prior) {
    const provider = paymentProviderRegistry.get('stripe');
    if (!provider.createPaymentIntent) throw new Error('Stripe PaymentIntent checkout is unavailable.');
    const intent = await provider.createPaymentIntent({
      bookingId: prior.bookingId, locationId: prior.locationId, productId: prior.productId,
      amountMinor: prior.amountMinor, currency: prior.currency, idempotencyKey: `web:${input.idempotencyKey}`,
      description: prior.description, customerEmail: prior.email ?? undefined
    });
    const checkoutSessionToken = await createCheckoutToken(prior.bookingId, prior.expiresAt);
    return { bookingId: prior.bookingId, checkoutSessionToken, clientSecret: intent.clientSecret, expiresAt: prior.expiresAt };
  }

  await pool.query(
    `INSERT INTO web_checkout_idempotency (idempotency_key, request_hash) VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.idempotencyKey, hash]
  );

  const clientId = input.clientId ?? await resolveGuestClient(input.contact);
  const expiresAt = new Date(Date.now() + appConfig.WEB_CHECKOUT_TTL_MINUTES * 60_000).toISOString();
  const catalogOffering = input.availability.locationProductId
    ? null
    : await getCatalogProductOffering(input.productId, input.locationId);
  const locationProductId = input.availability.locationProductId ?? catalogOffering?.offering.id;
  if (!locationProductId) throw new Error('The availability token does not identify a bookable offering.');
  const bookingIntent = {
    locationId: input.locationId,
    productId: input.productId,
    locationProductId,
    variantId: input.variantId,
    startAt: input.availability.startsAt,
    endAt: input.availability.endsAt,
    participants: input.quantity,
    durationMinutes: input.durationMinutes,
    options: input.options ?? []
  };
  const quote = await bookingQuoteService.quote(bookingIntent, { clientId });
  if (!quote.available) throw new Error('The selected booking is no longer available.');
  const offering = await getBookingOffering(locationProductId);
  if (!offering) throw new Error('The selected offering no longer exists.');
  const bookingProvider = bookingProviderRegistry.get(offering.bookingProvider);
  let holdId: string | undefined;
  if (offering.bookingProvider === 'core') {
    const hold = await createReservationHold({
      clientId, locationId: input.locationId, productId: input.productId,
      productOfferingId: locationProductId,
      productVariantId: input.variantId, quantity: input.quantity,
      startsAt: quote.configuration.startAt, endsAt: quote.configuration.endAt,
      expiresAt, idempotencyKey: `web-hold:${input.idempotencyKey}`,
      metadata: { source: 'wordpress', quoteId: quote.quoteId }
    });
    holdId = hold.id;
  }
  if (!bookingProvider.createBooking) throw new Error(`${bookingProvider.displayName} booking creation is unavailable.`);
  const booking = await bookingProvider.createBooking({
    intent: {
      ...bookingIntent,
      startAt: quote.configuration.startAt,
      endAt: quote.configuration.endAt,
      durationMinutes: quote.configuration.durationMinutes ?? undefined
    },
    clientId,
    holdId,
    idempotencyKey: `web-booking:${input.idempotencyKey}`,
    source: 'wordpress'
  });
  await pool.query(
    `UPDATE bookings SET source = 'self-service', booking_source = 'wordpress',
       created_by_client_id = $2, reservation_expires_at = $3, payment_status = 'processing'
     WHERE booking_id = $1`,
    [booking.bookingId, input.clientId ?? null, expiresAt]
  );
  await pool.query(
    `UPDATE web_checkout_idempotency SET booking_id = $2, updated_at = now()
     WHERE idempotency_key = $1`,
    [input.idempotencyKey, booking.bookingId]
  );

  const paymentProvider = paymentProviderRegistry.get('stripe');
  if (!paymentProvider.createPaymentIntent) throw new Error('Stripe PaymentIntent checkout is unavailable.');
  const payment = await pool.query<{ payment_id: string }>(
    `INSERT INTO payments (booking_id, amount, type, provider, status, amount_minor, currency, idempotency_key, metadata)
     VALUES ($1, $2, 'card', 'stripe', 'processing', $3, $4, $5, $6::jsonb)
     RETURNING payment_id`,
    [booking.bookingId, quote.total / 100, quote.total, quote.currency, `web:${input.idempotencyKey}`,
      JSON.stringify({ source: 'wordpress' })]
  );
  const paymentIntent = await paymentProvider.createPaymentIntent({
    bookingId: booking.bookingId, locationId: input.locationId, productId: input.productId,
    amountMinor: quote.total, currency: quote.currency, idempotencyKey: `web:${input.idempotencyKey}`,
    description: quote.items.map((item) => item.productName).join(', '), customerEmail: input.contact.email
  });
  await pool.query(
    `UPDATE payments SET provider_payment_id = $2, metadata = metadata || $3::jsonb, updated_at = now()
     WHERE payment_id = $1`,
    [payment.rows[0].payment_id, paymentIntent.externalPaymentId, JSON.stringify({ stripeStatus: paymentIntent.status })]
  );
  await pool.query(
    `INSERT INTO web_audit_events (action, actor_type, actor_id, booking_id, client_id, details)
     VALUES ('wordpress.checkout.create', 'wordpress_service', NULL, $1, $2, $3::jsonb)`,
    [booking.bookingId, clientId, JSON.stringify({ locationId: input.locationId, productId: input.productId })]
  );
  const checkoutSessionToken = await createCheckoutToken(booking.bookingId, expiresAt);
  return { bookingId: booking.bookingId, checkoutSessionToken, clientSecret: paymentIntent.clientSecret, expiresAt };
}
