import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { normalizeLifecycleStatus, type BookingLifecycleStatus } from '../bookings/booking-lifecycle.service.js';
import { InvalidBookingPaymentStateError, InvalidPaymentTransitionError } from '../bookings/booking.errors.js';

export type PaymentLifecycleStatus =
  | 'unpaid'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'refund_pending'
  | 'partially_refunded'
  | 'refunded'
  | 'refund_failed';

export interface PaymentTransitionMetadata extends Record<string, unknown> {
  actorType?: 'system' | 'client' | 'admin' | 'stripe' | 'regiondo' | 'job' | 'integration';
  actorId?: string;
  reason?: string;
  source?: string;
  timestamp?: string;
}

const transitions: Readonly<Record<PaymentLifecycleStatus, ReadonlySet<PaymentLifecycleStatus>>> = {
  unpaid: new Set(['processing', 'paid', 'failed']),
  processing: new Set(['unpaid', 'paid', 'failed']),
  paid: new Set(['refund_pending', 'partially_refunded', 'refunded']),
  failed: new Set(['unpaid', 'processing', 'paid']),
  refund_pending: new Set(['partially_refunded', 'refunded', 'refund_failed']),
  partially_refunded: new Set(['refund_pending', 'refunded']),
  refunded: new Set(),
  refund_failed: new Set(['refund_pending', 'partially_refunded', 'refunded'])
};

export function canTransitionPayment(from: PaymentLifecycleStatus, to: PaymentLifecycleStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function getAllowedPaymentTransitions(from: PaymentLifecycleStatus): PaymentLifecycleStatus[] {
  return [...transitions[from]];
}

export function assertPaymentTransition(from: PaymentLifecycleStatus, to: PaymentLifecycleStatus): void {
  if (!canTransitionPayment(from, to)) throw new InvalidPaymentTransitionError(from, to);
}

export function assertBookingPaymentCombination(
  bookingStatus: BookingLifecycleStatus,
  paymentStatus: PaymentLifecycleStatus
): void {
  if (bookingStatus === 'payment_failed' && !['unpaid', 'processing', 'failed'].includes(paymentStatus)) {
    throw new InvalidBookingPaymentStateError(bookingStatus, paymentStatus);
  }
  if (['confirmed', 'checked_in', 'in_progress', 'completed', 'no_show'].includes(bookingStatus) &&
      paymentStatus === 'failed') {
    throw new InvalidBookingPaymentStateError(bookingStatus, paymentStatus);
  }
  if (['draft', 'held', 'payment_pending'].includes(bookingStatus) &&
      ['partially_refunded', 'refunded'].includes(paymentStatus)) {
    throw new InvalidBookingPaymentStateError(bookingStatus, paymentStatus);
  }
}

export async function transitionPaymentState(
  bookingId: string,
  to: PaymentLifecycleStatus,
  metadata: PaymentTransitionMetadata = {}
): Promise<void> {
  await withTransaction((client) => transitionPaymentStateInTransaction(client, bookingId, to, metadata));
}

export async function transitionPaymentStateInTransaction(
  client: PoolClient,
  bookingId: string,
  to: PaymentLifecycleStatus,
  metadata: PaymentTransitionMetadata = {}
): Promise<void> {
  const result = await client.query<{ status: string; payment_status: PaymentLifecycleStatus }>(
    `SELECT status, payment_status FROM bookings WHERE booking_id = $1 FOR UPDATE`,
    [bookingId]
  );
  if (!result.rowCount) throw new Error(`Booking ${bookingId} was not found.`);
  const from = result.rows[0].payment_status;
  const bookingStatus = normalizeLifecycleStatus(result.rows[0].status);
  assertPaymentTransition(from, to);
  assertBookingPaymentCombination(bookingStatus, to);
  if (from === to) return;

  const occurredAt = typeof metadata.timestamp === 'string' ? metadata.timestamp : new Date().toISOString();
  await client.query(
    `UPDATE bookings SET payment_status = $2, updated_at = now() WHERE booking_id = $1`,
    [bookingId, to]
  );
  await client.query(
    `INSERT INTO payment_state_events (
       booking_id, from_status, to_status, actor_type, actor_id, reason, source, occurred_at, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
    [
      bookingId, from, to, metadata.actorType ?? 'system', metadata.actorId ?? null,
      metadata.reason ?? null, metadata.source ?? null, occurredAt, JSON.stringify(metadata)
    ]
  );
}
