import { createHash } from 'node:crypto';
import { appConfig } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { ConflictHttpError, HttpError } from '../../http/errors.js';
import { createReservationHold } from '../availability/reservation-hold.service.js';
import { bookingProviderRegistry } from '../bookings/booking-provider.js';
import { ProviderUnavailableError } from '../bookings/booking.errors.js';
import { bookingQuoteService } from '../bookings/booking-quote.service.js';
import { getBookingOffering, getCatalogProductOffering } from '../catalog/catalog.repository.js';
import { paymentProviderRegistry } from '../payments/payment-provider.registry.js';
import { transitionPaymentState } from '../payments/payment-lifecycle.service.js';
import { createCheckoutToken } from './web-token.service.js';
import type { WebAvailabilityTokenPayload } from './availability-token.js';
import type { WebCheckoutContact, WebCheckoutIdentity } from './web-checkout-identity.js';

export interface WebCheckoutInput {
  identity: WebCheckoutIdentity;
  locationId: string;
  productId: string;
  variantId?: string;
  quantity: number;
  durationMinutes?: number;
  options?: Array<{ optionId: string; value?: string; quantity?: number }>;
  availability: WebAvailabilityTokenPayload;
  idempotencyKey: string;
}

export interface WebCheckoutResult {
  bookingId: string;
  checkoutSessionToken: string;
  clientSecret: string;
  expiresAt: string;
}

export function webCheckoutRequestHash(input: WebCheckoutInput): string {
  return createHash('sha256').update(JSON.stringify({
    locationId: input.locationId,
    productId: input.productId,
    variantId: input.variantId ?? null,
    quantity: input.quantity,
    durationMinutes: input.durationMinutes ?? null,
    options: input.options ?? [],
    identity: input.identity.kind === 'authenticated'
      ? { kind: input.identity.kind, clientId: input.identity.clientId }
      : { kind: input.identity.kind, contact: input.identity.contact },
    availability: input.availability
  })).digest('hex');
}

async function resolveGuestClient(input: WebCheckoutContact): Promise<string> {
  const result = await pool.query<{ client_id: string }>(
    `INSERT INTO clients (first_name, last_name, display_name, email, phone_number)
     VALUES ($1, $2, NULLIF(TRIM(CONCAT_WS(' ', $1, $2)), ''), $3, $4)
     RETURNING client_id`,
    [input.firstName.trim(), input.lastName.trim(), input.email.trim().toLowerCase(), input.phone?.trim() || null]
  );
  return result.rows[0].client_id;
}

async function existingCheckout(key: string, hash: string, authenticatedClientId: string | null): Promise<{
  bookingId: string; clientId: string; locationId: string; productId: string; paymentRecordId: string;
  providerPaymentId: string | null; amountMinor: number;
  currency: string; description: string; email: string | null; expiresAt: string;
} | null> {
  const result = await pool.query<{
    booking_id: string; client_id: string; location_id: string; product_id: string; payment_id: string;
    provider_payment_id: string | null;
    amount_minor: string | number; currency: string; description: string; email: string | null; expires_at: string;
    request_hash: string; authenticated_client_id: string | null;
  }>(
    `SELECT booking.booking_id, booking.client_id, booking.location_id, item.product_id,
            payment.payment_id, payment.provider_payment_id, payment.amount_minor, payment.currency,
            item.product_name_snapshot AS description,
            COALESCE(booking.dashboard_data #>> '{contact_snapshot,email}', client.email::text) AS email,
            booking.reservation_expires_at AS expires_at, idem.request_hash,
            idem.authenticated_client_id
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
  if (row.authenticated_client_id !== authenticatedClientId || row.request_hash !== hash) {
    throw new ConflictHttpError('Idempotency key belongs to a different checkout identity or request.', 'IDEMPOTENCY_CONFLICT');
  }
  return {
    bookingId: row.booking_id, clientId: row.client_id, locationId: row.location_id, productId: row.product_id,
    paymentRecordId: row.payment_id, providerPaymentId: row.provider_payment_id,
    amountMinor: Number(row.amount_minor), currency: row.currency,
    description: row.description, email: row.email, expiresAt: row.expires_at
  };
}

export async function createWebCheckout(input: WebCheckoutInput): Promise<WebCheckoutResult> {
  const hash = webCheckoutRequestHash(input);
  const authenticatedClientId = input.identity.kind === 'authenticated' ? input.identity.clientId : null;
  const prior = await existingCheckout(input.idempotencyKey, hash, authenticatedClientId);
  if (prior) {
    const provider = paymentProviderRegistry.get('stripe');
    if (!provider.createPaymentIntent) throw new ProviderUnavailableError('Stripe PaymentIntent checkout is unavailable.');
    const intent = await provider.createPaymentIntent({
      bookingId: prior.bookingId, locationId: prior.locationId, productId: prior.productId,
      amountMinor: prior.amountMinor, currency: prior.currency, idempotencyKey: `web:${input.idempotencyKey}`,
      description: prior.description, customerEmail: prior.email ?? undefined
    });
    await pool.query(
      `UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, $2), status = 'processing',
         metadata = metadata || $3::jsonb, updated_at = now()
       WHERE payment_id = $1`,
      [prior.paymentRecordId, intent.externalPaymentId, JSON.stringify({ stripeStatus: intent.status })]
    );
    await pool.query(
      `UPDATE web_checkout_idempotency
       SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_error = NULL, updated_at = now()
       WHERE idempotency_key = $1`,
      [input.idempotencyKey]
    );
    const checkoutSessionToken = await createCheckoutToken(prior.bookingId, prior.expiresAt, authenticatedClientId);
    return { bookingId: prior.bookingId, checkoutSessionToken, clientSecret: intent.clientSecret, expiresAt: prior.expiresAt };
  }

  let resumeBookingId: string | null = null;
  const claim = await pool.query(
    `INSERT INTO web_checkout_idempotency (idempotency_key, request_hash, authenticated_client_id, status)
     VALUES ($1, $2, $3, 'in_progress')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_id`,
    [input.idempotencyKey, hash, authenticatedClientId]
  );
  if (!claim.rowCount) {
    const collision = await pool.query<{
      request_hash: string; authenticated_client_id: string | null; status: string; booking_id: string | null;
      updated_at: string;
    }>(
      `SELECT request_hash, authenticated_client_id, status, booking_id, updated_at
       FROM web_checkout_idempotency WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey]
    );
    const row = collision.rows[0];
    if (!row || row.request_hash !== hash || row.authenticated_client_id !== authenticatedClientId) {
      throw new ConflictHttpError('Idempotency key belongs to a different checkout identity or request.', 'IDEMPOTENCY_CONFLICT');
    }
    const staleInProgress = row.status === 'in_progress' &&
      new Date(row.updated_at).getTime() <= Date.now() - 5 * 60_000;
    if (row.status !== 'failed' && !staleInProgress) {
      throw new ConflictHttpError('This checkout request is already being processed.', 'IDEMPOTENCY_IN_PROGRESS');
    }
    const reclaimed = await pool.query(
      `UPDATE web_checkout_idempotency
       SET status = 'in_progress', last_error = NULL, updated_at = now()
       WHERE idempotency_key = $1
         AND (status = 'failed' OR (status = 'in_progress' AND updated_at <= now() - interval '5 minutes'))`,
      [input.idempotencyKey]
    );
    if (!reclaimed.rowCount) {
      throw new ConflictHttpError('This checkout request is already being processed.', 'IDEMPOTENCY_IN_PROGRESS');
    }
    resumeBookingId = row.booking_id;
  }

  try {
  const resumedOwner = resumeBookingId
    ? await pool.query<{ client_id: string }>(`SELECT client_id FROM bookings WHERE booking_id = $1`, [resumeBookingId])
    : null;
  const clientId = resumedOwner?.rows[0]?.client_id ?? (input.identity.kind === 'authenticated'
    ? input.identity.clientId
    : await resolveGuestClient(input.identity.contact));
  const expiresAt = new Date(Date.now() + appConfig.WEB_CHECKOUT_TTL_MINUTES * 60_000).toISOString();
  const catalogOffering = input.availability.locationProductId
    ? null
    : await getCatalogProductOffering(input.productId, input.locationId);
  const locationProductId = input.availability.locationProductId ?? catalogOffering?.offering.id;
  if (!locationProductId) throw new ConflictHttpError('The availability token does not identify a bookable offering.', 'AVAILABILITY_CHANGED');
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
  if (!quote.available) throw new ConflictHttpError('The selected booking is no longer available.', 'AVAILABILITY_CHANGED');
  const offering = await getBookingOffering(locationProductId);
  if (!offering) throw new HttpError(404, 'The selected offering no longer exists.', 'NOT_FOUND');
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
  if (!bookingProvider.createBooking) throw new ProviderUnavailableError(`${bookingProvider.displayName} booking creation is unavailable.`);
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
       created_by_client_id = $2, reservation_expires_at = $3,
       dashboard_data = COALESCE(dashboard_data, '{}'::jsonb) || jsonb_build_object('contact_snapshot', $4::jsonb)
     WHERE booking_id = $1`,
    [booking.bookingId, authenticatedClientId, expiresAt, JSON.stringify(input.identity.contact)]
  );
  await transitionPaymentState(booking.bookingId, 'processing', {
    actorType: 'client', actorId: authenticatedClientId ?? clientId,
    source: 'wordpress_checkout', reason: 'payment_intent_requested'
  });
  await pool.query(
    `UPDATE web_checkout_idempotency SET booking_id = $2, updated_at = now()
     WHERE idempotency_key = $1`,
    [input.idempotencyKey, booking.bookingId]
  );

  const paymentProvider = paymentProviderRegistry.get('stripe');
  if (!paymentProvider.createPaymentIntent) throw new ProviderUnavailableError('Stripe PaymentIntent checkout is unavailable.');
  const payment = await pool.query<{ payment_id: string }>(
    `INSERT INTO payments (booking_id, amount, type, provider, status, amount_minor, currency, idempotency_key, metadata)
     VALUES ($1, $2, 'card', 'stripe', 'processing', $3, $4, $5, $6::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
     RETURNING payment_id`,
    [booking.bookingId, quote.total / 100, quote.total, quote.currency, `web:${input.idempotencyKey}`,
      JSON.stringify({ source: 'wordpress' })]
  );
  const paymentIntent = await paymentProvider.createPaymentIntent({
    bookingId: booking.bookingId, locationId: input.locationId, productId: input.productId,
    amountMinor: quote.total, currency: quote.currency, idempotencyKey: `web:${input.idempotencyKey}`,
    description: quote.items.map((item) => item.productName).join(', '), customerEmail: input.identity.contact.email
  });
  await pool.query(
    `UPDATE payments SET provider_payment_id = $2, metadata = metadata || $3::jsonb, updated_at = now()
     WHERE payment_id = $1`,
    [payment.rows[0].payment_id, paymentIntent.externalPaymentId, JSON.stringify({ stripeStatus: paymentIntent.status })]
  );
  await pool.query(
    `UPDATE web_checkout_idempotency
     SET status = 'completed', completed_at = now(), last_error = NULL, updated_at = now()
     WHERE idempotency_key = $1`,
    [input.idempotencyKey]
  );
  await pool.query(
    `INSERT INTO web_audit_events (action, actor_type, actor_id, booking_id, client_id, details)
     VALUES ('wordpress.checkout.create', 'wordpress_service', NULL, $1, $2, $3::jsonb)`,
    [booking.bookingId, clientId, JSON.stringify({ locationId: input.locationId, productId: input.productId })]
  );
  const checkoutSessionToken = await createCheckoutToken(booking.bookingId, expiresAt, authenticatedClientId);
  return { bookingId: booking.bookingId, checkoutSessionToken, clientSecret: paymentIntent.clientSecret, expiresAt };
  } catch (error) {
    await pool.query(
      `UPDATE web_checkout_idempotency
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE idempotency_key = $1 AND status = 'in_progress'`,
      [input.idempotencyKey, (error instanceof Error ? error.message : String(error)).slice(0, 1000)]
    );
    throw error;
  }
}
