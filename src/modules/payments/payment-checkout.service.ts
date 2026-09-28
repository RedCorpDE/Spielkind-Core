import { appConfig } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { HoldExpiredError, ProviderSyncConflictError, ProviderUnavailableError } from '../bookings/booking.errors.js';
import { paymentProviderRegistry } from './payment-provider.registry.js';

interface CheckoutBookingRow {
  booking_id: string;
  client_id: string;
  status: string;
  booking_provider: string;
  amount_minor: string | number;
  currency: string;
  email: string | null;
  description: string | null;
  hold_expires_at: string | null;
  hold_status: string | null;
}

interface PaymentRow {
  payment_id: string;
  booking_id: string;
  status: string;
  amount_minor: string | number;
  currency: string;
  provider_checkout_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PaymentCheckoutResult {
  paymentId: string;
  bookingId: string;
  provider: 'stripe';
  status: string;
  redirectUrl: string | null;
  expiresAt: string | null;
}

function checkoutUrl(template: string | undefined, bookingId: string, kind: string): string {
  if (!template) throw new ProviderUnavailableError(`Stripe checkout ${kind} URL is not configured.`);
  return template.replaceAll('{BOOKING_ID}', encodeURIComponent(bookingId));
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

export async function createStripeCheckout(input: {
  bookingId: string;
  clientId: string;
  idempotencyKey: string;
}): Promise<PaymentCheckoutResult> {
  const reserved = await withTransaction(async (client) => {
    const booking = await client.query<CheckoutBookingRow>(
      `SELECT booking.booking_id, booking.client_id, booking.status, booking.booking_provider,
              ROUND(booking.total_amount * 100)::bigint AS amount_minor, booking.currency,
              owner.email::text AS email,
              item_summary.description,
              hold.expires_at AS hold_expires_at, hold.status AS hold_status
       FROM bookings booking
       INNER JOIN clients owner ON owner.client_id = booking.client_id
       LEFT JOIN LATERAL (
         SELECT STRING_AGG(item.product_name_snapshot, ', ' ORDER BY item.created_at) AS description
         FROM booking_items item WHERE item.booking_id = booking.booking_id
       ) item_summary ON true
       LEFT JOIN LATERAL (
         SELECT status, expires_at FROM reservation_holds
         WHERE booking_id = booking.booking_id ORDER BY created_at DESC LIMIT 1
       ) hold ON true
       WHERE booking.booking_id = $1 AND booking.client_id = $2
       FOR UPDATE OF booking`,
      [input.bookingId, input.clientId]
    );
    const row = booking.rows[0];
    if (!row) throw new ProviderSyncConflictError('Booking was not found or is not owned by this client.');
    if (row.booking_provider !== 'core') throw new ProviderSyncConflictError('This booking uses its external provider checkout.');
    if (row.status !== 'payment_pending' && row.status !== 'held') {
      throw new ProviderSyncConflictError(`Checkout cannot be created while the booking is ${row.status}.`);
    }
    if (row.hold_status !== 'active' || !row.hold_expires_at || new Date(row.hold_expires_at).getTime() <= Date.now()) {
      throw new HoldExpiredError();
    }
    const amountMinor = Number(row.amount_minor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new ProviderSyncConflictError('Booking total is not a valid Stripe amount.');
    }

    const existing = await client.query<PaymentRow>(
      `SELECT payment_id, booking_id, status, amount_minor, currency, provider_checkout_id, metadata
       FROM payments WHERE idempotency_key = $1 FOR UPDATE`,
      [input.idempotencyKey]
    );
    if (existing.rowCount) {
      const payment = existing.rows[0];
      if (payment.booking_id !== input.bookingId || Number(payment.amount_minor) !== amountMinor || payment.currency !== row.currency) {
        throw new ProviderSyncConflictError('The idempotency key belongs to a different payment request.');
      }
      if (payment.provider_checkout_id) {
        return {
          payment,
          checkoutInput: null,
          existingResult: {
            paymentId: payment.payment_id,
            bookingId: payment.booking_id,
            provider: 'stripe' as const,
            status: payment.status,
            redirectUrl: readMetadataString(payment.metadata, 'checkoutUrl'),
            expiresAt: readMetadataString(payment.metadata, 'checkoutExpiresAt')
          }
        };
      }
      return { payment, checkoutInput: row, existingResult: null };
    }

    const activeForBooking = await client.query<PaymentRow>(
      `SELECT payment_id, booking_id, status, amount_minor, currency, provider_checkout_id, metadata
       FROM payments WHERE booking_id = $1 AND provider = 'stripe'
         AND status IN ('requires_payment', 'processing')
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [input.bookingId]
    );
    if (activeForBooking.rowCount) {
      const payment = activeForBooking.rows[0];
      if (Number(payment.amount_minor) !== amountMinor || payment.currency !== row.currency) {
        throw new ProviderSyncConflictError('The active Stripe payment no longer matches the booking total.');
      }
      if (payment.provider_checkout_id) {
        return {
          payment,
          checkoutInput: null,
          existingResult: {
            paymentId: payment.payment_id,
            bookingId: payment.booking_id,
            provider: 'stripe' as const,
            status: payment.status,
            redirectUrl: readMetadataString(payment.metadata, 'checkoutUrl'),
            expiresAt: readMetadataString(payment.metadata, 'checkoutExpiresAt')
          }
        };
      }
      return { payment, checkoutInput: row, existingResult: null };
    }

    const inserted = await client.query<PaymentRow>(
      `INSERT INTO payments (
         booking_id, amount, type, provider, status, amount_minor, currency, idempotency_key, metadata
       ) VALUES ($1, $2, 'card', 'stripe', 'requires_payment', $3, $4, $5, '{}'::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING payment_id, booking_id, status, amount_minor, currency, provider_checkout_id, metadata`,
      [input.bookingId, amountMinor / 100, amountMinor, row.currency, input.idempotencyKey]
    );
    if (inserted.rowCount) return { payment: inserted.rows[0], checkoutInput: row, existingResult: null };
    const raced = await client.query<PaymentRow>(
      `SELECT payment_id, booking_id, status, amount_minor, currency, provider_checkout_id, metadata
       FROM payments WHERE idempotency_key = $1 FOR UPDATE`,
      [input.idempotencyKey]
    );
    const payment = raced.rows[0];
    if (!payment || payment.booking_id !== input.bookingId || Number(payment.amount_minor) !== amountMinor || payment.currency !== row.currency) {
      throw new ProviderSyncConflictError('The idempotency key belongs to a different payment request.');
    }
    return { payment, checkoutInput: row, existingResult: null };
  });

  if (reserved.existingResult) return reserved.existingResult;
  const booking = reserved.checkoutInput;
  if (!booking) throw new Error('Missing Stripe checkout input.');
  const provider = paymentProviderRegistry.get('stripe');
  const checkout = await provider.createCheckout({
    bookingId: input.bookingId,
    amountMinor: Number(reserved.payment.amount_minor),
    currency: reserved.payment.currency,
    idempotencyKey: input.idempotencyKey,
    description: booking.description || `Booking ${input.bookingId}`,
    customerEmail: booking.email ?? undefined,
    successUrl: checkoutUrl(appConfig.STRIPE_CHECKOUT_SUCCESS_URL, input.bookingId, 'success'),
    cancelUrl: checkoutUrl(appConfig.STRIPE_CHECKOUT_CANCEL_URL, input.bookingId, 'cancel')
  });

  const updated = await pool.query<PaymentRow>(
    `UPDATE payments
     SET provider_checkout_id = $2, status = 'processing',
         metadata = metadata || $3::jsonb, updated_at = now()
     WHERE payment_id = $1
     RETURNING payment_id, booking_id, status, amount_minor, currency, provider_checkout_id, metadata`,
    [reserved.payment.payment_id, checkout.externalCheckoutId, JSON.stringify({
      checkoutUrl: checkout.redirectUrl,
      checkoutExpiresAt: checkout.expiresAt
    })]
  );
  const payment = updated.rows[0];
  return {
    paymentId: payment.payment_id,
    bookingId: payment.booking_id,
    provider: 'stripe',
    status: payment.status,
    redirectUrl: checkout.redirectUrl,
    expiresAt: checkout.expiresAt
  };
}
