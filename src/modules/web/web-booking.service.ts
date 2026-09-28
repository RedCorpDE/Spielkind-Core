import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { getClientBooking } from '../../client-api/repository.js';
import { getCancellationQuote, requestCancellation, type CancellationQuote } from '../cancellations/cancellation.service.js';
import { paymentProviderRegistry } from '../payments/payment-provider.registry.js';
import { recordRefund } from '../payments/refund.service.js';

export interface WebBookingDto {
  id: string;
  status: string;
  paymentStatus: string;
  startsAt: string;
  endsAt: string;
  quantity: number;
  location: { id: string; name: string };
  product: { id: string; name: string; variantId: string | null; variantName: string | null };
  total: { amount: number; currency: string };
  cancellation: CancellationQuote;
  cancelledAt: string | null;
  cancellationReason: string | null;
  refund: { amount: number; currency: string; status: string } | null;
}

export async function getWebBooking(bookingId: string): Promise<WebBookingDto | null> {
  const result = await pool.query<{
    booking_id: string; status: string; payment_status: string; dt_from: string; dt_to: string;
    guest_count: number; location_id: string; location_name: string; product_id: string;
    product_name: string; product_variant_id: string | null; variant_name: string | null;
    total_minor: string | number; currency: string; cancelled_at: string | null; cancellation_reason: string | null;
    refund_amount: string | number | null; refund_currency: string | null; refund_status: string | null;
  }>(
    `SELECT booking.booking_id, booking.status, booking.payment_status, booking.dt_from, booking.dt_to,
            booking.guest_count, location.location_id, location.title AS location_name,
            item.product_id, item.product_name_snapshot AS product_name,
            item.product_variant_id, item.variant_name_snapshot AS variant_name,
            item.subtotal_gross AS total_minor, booking.currency, booking.cancelled_at, booking.cancellation_reason,
            refund.amount_minor AS refund_amount, refund.currency AS refund_currency, refund.status AS refund_status
     FROM bookings booking
     INNER JOIN locations location ON location.location_id = booking.location_id
     INNER JOIN LATERAL (
       SELECT * FROM booking_items WHERE booking_id = booking.booking_id ORDER BY created_at LIMIT 1
     ) item ON true
     LEFT JOIN LATERAL (
       SELECT amount_minor, currency, status FROM refunds WHERE booking_id = booking.booking_id
       ORDER BY created_at DESC LIMIT 1
     ) refund ON true
     WHERE booking.booking_id = $1 LIMIT 1`,
    [bookingId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const quote = await getCancellationQuote(bookingId);
  return {
    id: row.booking_id,
    status: row.status,
    paymentStatus: row.payment_status,
    startsAt: row.dt_from,
    endsAt: row.dt_to,
    quantity: row.guest_count,
    location: { id: row.location_id, name: row.location_name },
    product: {
      id: row.product_id, name: row.product_name, variantId: row.product_variant_id, variantName: row.variant_name
    },
    total: { amount: Number(row.total_minor), currency: row.currency },
    cancellation: quote,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    refund: row.refund_status ? {
      amount: Number(row.refund_amount ?? 0), currency: row.refund_currency ?? row.currency, status: row.refund_status
    } : null
  };
}

export async function canClientCancelBooking(clientId: string, bookingId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM bookings booking
     WHERE booking.booking_id = $2 AND (
       booking.client_id = $1 OR booking.created_by_client_id = $1 OR EXISTS (
         SELECT 1 FROM client_group_members membership
         WHERE membership.group_id = booking.client_group_id AND membership.client_id = $1
           AND membership.role IN ('owner', 'admin')
       )
     ) LIMIT 1`,
    [clientId, bookingId]
  );
  return Boolean(result.rowCount);
}

export async function listWebClientBookings(clientId: string): Promise<WebBookingDto[]> {
  const visible = await pool.query<{ booking_id: string }>(
    `SELECT DISTINCT booking.booking_id FROM bookings booking
     LEFT JOIN booking_participants participant ON participant.booking_id = booking.booking_id
     LEFT JOIN client_group_members membership ON membership.group_id = booking.client_group_id
     WHERE booking.client_id = $1 OR booking.created_by_client_id = $1
        OR participant.client_id = $1 OR membership.client_id = $1
     ORDER BY booking.booking_id`,
    [clientId]
  );
  return (await Promise.all(visible.rows.map((row) => getWebBooking(row.booking_id))))
    .filter((item): item is WebBookingDto => item !== null)
    .sort((left, right) => right.startsAt.localeCompare(left.startsAt));
}

export async function getOwnedWebBooking(clientId: string, bookingId: string): Promise<WebBookingDto | null> {
  if (!(await getClientBooking(clientId, bookingId))) return null;
  return getWebBooking(bookingId);
}

export async function cancelWebBooking(input: {
  bookingId: string;
  actorType: 'client' | 'guest' | 'staff';
  actorClientId?: string;
  actorId?: string;
  reason?: string;
}): Promise<WebBookingDto> {
  const quote = await getCancellationQuote(input.bookingId);
  const result = await requestCancellation(input.bookingId);
  await pool.query(
    `UPDATE bookings SET cancelled_by_client_id = $2, cancellation_reason = $3,
       cancelled_at = CASE WHEN status IN ('cancelled', 'canceled') THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
       updated_at = now() WHERE booking_id = $1`,
    [input.bookingId, input.actorClientId ?? null, input.reason?.trim() || null]
  );

  if (result.status === 'cancel_requested' && quote.refundableAmount > 0) {
    const paymentResult = await pool.query<{
      payment_id: string; provider_payment_id: string | null; amount_minor: string | number; currency: string;
    }>(
      `SELECT payment_id, provider_payment_id, amount_minor, currency FROM payments
       WHERE booking_id = $1 AND provider = 'stripe' AND status IN ('succeeded', 'partially_refunded')
       ORDER BY created_at DESC LIMIT 1`,
      [input.bookingId]
    );
    const payment = paymentResult.rows[0];
    if (payment?.provider_payment_id) {
      await pool.query(`UPDATE bookings SET payment_status = 'refund_pending' WHERE booking_id = $1`, [input.bookingId]);
      const idempotencyKey = `cancel:${input.bookingId}:${quote.refundableAmount}`;
      const providerRefund = await paymentProviderRegistry.get('stripe').refund({
        externalPaymentId: payment.provider_payment_id,
        amountMinor: quote.refundableAmount,
        currency: payment.currency,
        idempotencyKey,
        bookingId: input.bookingId
      });
      const status = providerRefund.status === 'succeeded' ? 'succeeded' : 'processing';
      await recordRefund({
        paymentId: payment.payment_id, bookingId: input.bookingId, provider: 'stripe',
        providerRefundId: providerRefund.externalRefundId, amountMinor: quote.refundableAmount,
        currency: payment.currency, reason: input.reason, status, idempotencyKey
      });
      await pool.query(
        `UPDATE bookings SET payment_status = $2,
         status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
         WHERE booking_id = $1`,
        [input.bookingId, status === 'succeeded' ? 'refunded' : 'refund_pending']
      );
      await pool.query(`DELETE FROM consumptions WHERE booking_id = $1 AND dt_to > now()`, [input.bookingId]);
      await pool.query(
        `INSERT INTO web_audit_events (action, actor_type, actor_id, booking_id, details)
         VALUES ('stripe.refund.create', 'stripe', NULL, $1, $2::jsonb)`,
        [input.bookingId, JSON.stringify({ refundId: providerRefund.externalRefundId, amountMinor: quote.refundableAmount })]
      );
    }
  }

  await pool.query(
    `INSERT INTO web_audit_events (action, actor_type, actor_id, booking_id, client_id, details)
     VALUES ($1, $2, $3, $4, $3, $5::jsonb)`,
    [input.actorType === 'guest' ? 'guest.booking.cancel' : input.actorType === 'staff' ? 'staff.booking.cancel' : 'client.booking.cancel',
      input.actorType, input.actorId ?? input.actorClientId ?? null, input.bookingId, JSON.stringify({ reason: input.reason ?? null })]
  );
  const booking = await getWebBooking(input.bookingId);
  if (!booking) throw new Error('Booking disappeared after cancellation.');
  return booking;
}

export async function webBookingStatus(bookingId: string) {
  const result = await pool.query<{
    booking_id: string; status: string; payment_status: string; reservation_expires_at: string | null;
    refund_status: string | null;
  }>(
    `SELECT booking.booking_id, booking.status, booking.payment_status, booking.reservation_expires_at,
       (SELECT status FROM refunds WHERE booking_id = booking.booking_id ORDER BY created_at DESC LIMIT 1) AS refund_status
     FROM bookings booking WHERE booking.booking_id = $1 LIMIT 1`,
    [bookingId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    bookingId: row.booking_id,
    bookingStatus: row.status,
    paymentStatus: row.payment_status,
    refundStatus: row.refund_status,
    expiresAt: row.reservation_expires_at
  };
}

