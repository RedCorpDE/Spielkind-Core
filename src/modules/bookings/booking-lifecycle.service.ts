import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { InvalidBookingTransitionError } from './booking.errors.js';

export type BookingLifecycleStatus =
  | 'draft'
  | 'held'
  | 'payment_pending'
  | 'confirmed'
  | 'change_requested'
  | 'cancel_requested'
  | 'cancelled'
  | 'checked_in'
  | 'completed'
  | 'payment_failed'
  | 'expired';

const transitions: Readonly<Record<BookingLifecycleStatus, ReadonlySet<BookingLifecycleStatus>>> = {
  draft: new Set(['held', 'payment_pending', 'expired', 'cancelled']),
  held: new Set(['payment_pending', 'expired', 'cancelled']),
  payment_pending: new Set(['confirmed', 'change_requested', 'payment_failed', 'expired', 'cancelled']),
  confirmed: new Set(['change_requested', 'cancel_requested', 'checked_in', 'completed']),
  change_requested: new Set(['confirmed', 'cancel_requested', 'cancelled']),
  cancel_requested: new Set(['confirmed', 'cancelled']),
  cancelled: new Set(),
  checked_in: new Set(['completed']),
  completed: new Set(),
  payment_failed: new Set(['payment_pending', 'confirmed', 'change_requested', 'cancelled', 'expired']),
  expired: new Set()
};

export function canTransitionBooking(from: BookingLifecycleStatus, to: BookingLifecycleStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertBookingTransition(from: BookingLifecycleStatus, to: BookingLifecycleStatus): void {
  if (!canTransitionBooking(from, to)) throw new InvalidBookingTransitionError(from, to);
}

export async function transitionBooking(
  bookingId: string,
  to: BookingLifecycleStatus,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await withTransaction(async (client) => transitionBookingInTransaction(client, bookingId, to, metadata));
}

export async function transitionBookingInTransaction(
  client: PoolClient,
  bookingId: string,
  to: BookingLifecycleStatus,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM bookings WHERE booking_id = $1 FOR UPDATE`,
    [bookingId]
  );
  if (!result.rowCount) throw new Error(`Booking ${bookingId} was not found.`);
  const from = normalizeLifecycleStatus(result.rows[0].status);
  assertBookingTransition(from, to);
  await client.query(
    `UPDATE bookings SET status = $2, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END, updated_at = now()
     WHERE booking_id = $1`,
    [bookingId, to]
  );
  if (from !== to) {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('booking', $1, $2, $3::jsonb)`,
      [bookingId, `booking.${to}`, JSON.stringify({ bookingId, from, to, ...metadata })]
    );
  }
}

export function normalizeLifecycleStatus(status: string): BookingLifecycleStatus {
  if (status === 'pending' || status === 'processing') return 'payment_pending';
  if (status === 'canceled' || status === 'rejected') return 'cancelled';
  if (status === 'unknown') return 'draft';
  if (status === 'no_show') return 'completed';
  if (status in transitions) return status as BookingLifecycleStatus;
  throw new Error(`Unsupported booking status: ${status}`);
}

