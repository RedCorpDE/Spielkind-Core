import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { transitionBookingInTransaction } from '../bookings/booking-lifecycle.service.js';
import { ProviderSyncConflictError } from '../bookings/booking.errors.js';

interface PaymentRecord {
  payment_id: string;
  booking_id: string;
  status: string;
  amount_minor: string | number;
  currency: string;
  provider_payment_id: string | null;
  provider_checkout_id: string | null;
}

interface BookingRecord {
  booking_id: string;
  status: string;
  dt_from: string;
  dt_to: string;
  total_minor: string | number;
  currency: string;
}

interface HoldRecord {
  reservation_hold_id: string;
  status: 'active' | 'consumed' | 'expired' | 'released';
}

export interface ConfirmStripePaymentInput {
  bookingId?: string;
  providerCheckoutId?: string;
  providerPaymentId?: string;
  amountMinor: number;
  currency: string;
  externalEventId: string;
  eventType: string;
}

export interface ConfirmStripePaymentResult {
  bookingId: string;
  paymentId: string;
  status: 'confirmed' | 'already_confirmed' | 'requires_manual_review';
  consumptionsCreated: number;
}

export interface UpdateStripePaymentStateInput {
  bookingId?: string;
  providerCheckoutId?: string;
  providerPaymentId?: string;
  externalEventId: string;
  eventType: string;
  outcome: 'processing' | 'failed' | 'cancelled';
  failureMessage?: string;
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '40001';
}

async function withSerializableRetry<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(work, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new Error('Unreachable serializable transaction state.');
}

async function findPayment(client: PoolClient, input: ConfirmStripePaymentInput): Promise<PaymentRecord> {
  const result = await client.query<PaymentRecord>(
    `SELECT payment_id, booking_id, status, amount_minor, currency, provider_payment_id, provider_checkout_id
     FROM payments
     WHERE provider = 'stripe' AND (
       ($1::text IS NOT NULL AND provider_checkout_id = $1)
       OR ($2::text IS NOT NULL AND provider_payment_id = $2)
       OR ($3::uuid IS NOT NULL AND booking_id = $3)
     )
     ORDER BY CASE WHEN provider_checkout_id = $1 THEN 0 WHEN provider_payment_id = $2 THEN 1 ELSE 2 END,
       CASE WHEN status IN ('requires_payment', 'processing') THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1 FOR UPDATE`,
    [input.providerCheckoutId ?? null, input.providerPaymentId ?? null, input.bookingId ?? null]
  );
  if (!result.rowCount) throw new ProviderSyncConflictError('Stripe payment could not be matched to a Core payment.');
  return result.rows[0];
}

async function emitOutbox(
  client: PoolClient,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
  dedupeKey: string
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload), dedupeKey]
  );
}

export async function confirmStripePayment(input: ConfirmStripePaymentInput): Promise<ConfirmStripePaymentResult> {
  return withSerializableRetry(async (client) => {
    const payment = await findPayment(client, input);
    if ((input.bookingId && input.bookingId !== payment.booking_id) ||
        (input.providerCheckoutId && payment.provider_checkout_id && input.providerCheckoutId !== payment.provider_checkout_id) ||
        (input.providerPaymentId && payment.provider_payment_id && input.providerPaymentId !== payment.provider_payment_id)) {
      throw new ProviderSyncConflictError('Stripe event identifiers conflict with the matched Core payment.');
    }
    const bookingResult = await client.query<BookingRecord>(
      `SELECT booking_id, status, dt_from, dt_to, ROUND(total_amount * 100)::bigint AS total_minor, currency
       FROM bookings WHERE booking_id = $1 FOR UPDATE`,
      [payment.booking_id]
    );
    const booking = bookingResult.rows[0];
    if (!booking) throw new ProviderSyncConflictError('Payment references a missing booking.');

    const expectedAmount = Number(payment.amount_minor);
    const bookingAmount = Number(booking.total_minor);
    const currency = input.currency.toUpperCase();
    if (input.amountMinor !== expectedAmount || bookingAmount !== expectedAmount ||
        currency !== payment.currency || booking.currency !== payment.currency) {
      throw new ProviderSyncConflictError('Stripe payment amount or currency does not match the authoritative booking total.');
    }

    await client.query(
      `UPDATE payments SET status = 'succeeded', provider_payment_id = COALESCE($2, provider_payment_id),
         provider_checkout_id = COALESCE($3, provider_checkout_id), completed_at = COALESCE(completed_at, now()),
         metadata = metadata || $4::jsonb, updated_at = now()
       WHERE payment_id = $1`,
      [payment.payment_id, input.providerPaymentId ?? null, input.providerCheckoutId ?? null,
        JSON.stringify({ lastStripeEventId: input.externalEventId, lastStripeEventType: input.eventType })]
    );

    if (payment.status === 'succeeded' && booking.status === 'confirmed') {
      return { bookingId: booking.booking_id, paymentId: payment.payment_id, status: 'already_confirmed', consumptionsCreated: 0 };
    }

    const holdResult = await client.query<HoldRecord>(
      `SELECT reservation_hold_id, status FROM reservation_holds
       WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [booking.booking_id]
    );
    const hold = holdResult.rows[0];
    if (!hold) throw new ProviderSyncConflictError('Paid booking has no reservation hold to consume.');

    const allocations = await client.query<{ resource_id: string; capacity_used: number }>(
      `SELECT resource_id, capacity_used FROM reservation_hold_allocations
       WHERE reservation_hold_id = $1 ORDER BY resource_id`,
      [hold.reservation_hold_id]
    );
    if (!allocations.rowCount) throw new ProviderSyncConflictError('Paid booking hold has no resource allocations.');

    const resourceIds = allocations.rows.map((row) => row.resource_id);
    const resources = await client.query<{ resource_id: string; title: string; capacity_available: number; operational_status: string }>(
      `SELECT resource_id, title, capacity_available, operational_status FROM resources
       WHERE resource_id = ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE`,
      [resourceIds]
    );
    const resourceMap = new Map(resources.rows.map((row) => [row.resource_id, row]));
    let conflict: string | null = null;
    for (const allocation of allocations.rows) {
      const resource = resourceMap.get(allocation.resource_id);
      if (!resource || resource.operational_status !== 'active') {
        conflict = `Resource ${allocation.resource_id} is unavailable.`;
        break;
      }
      const usage = await client.query<{ used: string | number }>(
        `SELECT
           COALESCE((SELECT SUM(capacity_used) FROM consumptions
             WHERE resource_id = $1 AND booking_id <> $4
               AND type IN ('reserved', 'consumed', 'blocked', 'maintenance')
               AND tstzrange(dt_from, dt_to, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')), 0)
           + COALESCE((SELECT SUM(allocation.capacity_used)
             FROM reservation_hold_allocations allocation
             INNER JOIN reservation_holds hold ON hold.reservation_hold_id = allocation.reservation_hold_id
             WHERE allocation.resource_id = $1 AND hold.reservation_hold_id <> $5
               AND hold.status = 'active' AND hold.expires_at > now()
               AND tstzrange(hold.starts_at, hold.ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')), 0) AS used`,
        [allocation.resource_id, booking.dt_from, booking.dt_to, booking.booking_id, hold.reservation_hold_id]
      );
      if (Number(usage.rows[0]?.used ?? 0) + allocation.capacity_used > resource.capacity_available) {
        conflict = `Resource ${resource.title} no longer has capacity for the paid booking.`;
        break;
      }
    }

    if (conflict) {
      if (booking.status !== 'change_requested') {
        await transitionBookingInTransaction(client, booking.booking_id, 'change_requested', {
          reason: 'paid_capacity_conflict', paymentId: payment.payment_id
        });
      }
      await emitOutbox(client, 'booking', booking.booking_id, 'provider.sync_conflict', {
        bookingId: booking.booking_id,
        paymentId: payment.payment_id,
        reason: conflict,
        provider: 'stripe'
      }, `stripe-capacity-conflict:${payment.payment_id}`);
      await emitOutbox(client, 'payment', payment.payment_id, 'payment.succeeded', {
        paymentId: payment.payment_id, bookingId: booking.booking_id, amountMinor: expectedAmount,
        currency: payment.currency, requiresManualReview: true
      }, `payment.succeeded:${payment.payment_id}`);
      return { bookingId: booking.booking_id, paymentId: payment.payment_id, status: 'requires_manual_review', consumptionsCreated: 0 };
    }

    await client.query(`DELETE FROM consumptions WHERE booking_id = $1 AND dt_to > now()`, [booking.booking_id]);
    for (const allocation of allocations.rows) {
      await client.query(
        `INSERT INTO consumptions (booking_id, resource_id, type, dt_from, dt_to, capacity_used)
         VALUES ($1, $2, 'reserved', $3::timestamptz, $4::timestamptz, $5)`,
        [booking.booking_id, allocation.resource_id, booking.dt_from, booking.dt_to, allocation.capacity_used]
      );
    }
    await client.query(
      `UPDATE reservation_holds SET status = 'consumed', updated_at = now() WHERE reservation_hold_id = $1`,
      [hold.reservation_hold_id]
    );
    await client.query(`UPDATE bookings SET paid_amount = $2, updated_at = now() WHERE booking_id = $1`, [booking.booking_id, expectedAmount / 100]);
    await transitionBookingInTransaction(client, booking.booking_id, 'confirmed', {
      paymentId: payment.payment_id, provider: 'stripe'
    });
    await emitOutbox(client, 'payment', payment.payment_id, 'payment.succeeded', {
      paymentId: payment.payment_id, bookingId: booking.booking_id, amountMinor: expectedAmount,
      currency: payment.currency
    }, `payment.succeeded:${payment.payment_id}`);

    return {
      bookingId: booking.booking_id,
      paymentId: payment.payment_id,
      status: 'confirmed',
      consumptionsCreated: allocations.rows.length
    };
  });
}

export async function updateStripePaymentState(input: UpdateStripePaymentStateInput): Promise<{ bookingId: string; paymentId: string }> {
  return withSerializableRetry(async (client) => {
    const payment = await findPayment(client, {
      ...input,
      amountMinor: 0,
      currency: '',
      eventType: input.eventType,
      externalEventId: input.externalEventId
    });
    if ((input.bookingId && input.bookingId !== payment.booking_id) ||
        (input.providerCheckoutId && payment.provider_checkout_id && input.providerCheckoutId !== payment.provider_checkout_id) ||
        (input.providerPaymentId && payment.provider_payment_id && input.providerPaymentId !== payment.provider_payment_id)) {
      throw new ProviderSyncConflictError('Stripe event identifiers conflict with the matched Core payment.');
    }
    const bookingResult = await client.query<{ status: string }>(
      `SELECT status FROM bookings WHERE booking_id = $1 FOR UPDATE`,
      [payment.booking_id]
    );
    const bookingStatus = bookingResult.rows[0]?.status;
    if (!bookingStatus) throw new ProviderSyncConflictError('Payment references a missing booking.');

    // A delayed failure/expiry notification must never reverse an already successful payment.
    if (payment.status === 'succeeded' || bookingStatus === 'confirmed') {
      return { bookingId: payment.booking_id, paymentId: payment.payment_id };
    }
    await client.query(
      `UPDATE payments SET status = $2, provider_payment_id = COALESCE($3, provider_payment_id),
         provider_checkout_id = COALESCE($4, provider_checkout_id),
         metadata = metadata || $5::jsonb, updated_at = now()
       WHERE payment_id = $1`,
      [payment.payment_id, input.outcome, input.providerPaymentId ?? null, input.providerCheckoutId ?? null,
        JSON.stringify({
          lastStripeEventId: input.externalEventId,
          lastStripeEventType: input.eventType,
          ...(input.failureMessage ? { failureMessage: input.failureMessage } : {})
        })]
    );
    if (input.outcome === 'processing') return { bookingId: payment.booking_id, paymentId: payment.payment_id };

    const target = input.outcome === 'cancelled' ? 'expired' : 'payment_failed';
    if (bookingStatus === 'payment_pending' || bookingStatus === 'payment_failed') {
      await transitionBookingInTransaction(client, payment.booking_id, target, {
        paymentId: payment.payment_id, provider: 'stripe', eventType: input.eventType
      });
    }
    await client.query(
      `UPDATE reservation_holds SET status = CASE WHEN $2 = 'cancelled' THEN 'expired' ELSE 'released' END, updated_at = now()
       WHERE booking_id = $1 AND status = 'active'`,
      [payment.booking_id, input.outcome]
    );
    await emitOutbox(client, 'payment', payment.payment_id,
      input.outcome === 'cancelled' ? 'payment.cancelled' : 'payment.failed', {
        paymentId: payment.payment_id,
        bookingId: payment.booking_id,
        provider: 'stripe',
        ...(input.failureMessage ? { reason: input.failureMessage } : {})
      }, `payment.${input.outcome}:${payment.payment_id}`);
    return { bookingId: payment.booking_id, paymentId: payment.payment_id };
  });
}
