import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { BookingNotCancellableError } from '../bookings/booking.errors.js';
import { normalizeLifecycleStatus, transitionBookingInTransaction } from '../bookings/booking-lifecycle.service.js';
import { percentageOf } from '../commerce/money.js';

export interface CancellationRule {
  minimumHoursBeforeStart: number;
  refundBasisPoints: number;
  reason?: string;
}

export interface CancellationQuote {
  canCancel: boolean;
  bookingTotal: number;
  cancellationFee: number;
  refundableAmount: number;
  currency: string;
  reason: string;
}

export function calculateCancellationQuote(input: {
  bookingTotal: number;
  currency: string;
  startsAt: string;
  now: string;
  status: string;
  bookingProvider?: 'core' | 'regiondo';
  rules: CancellationRule[];
}): CancellationQuote {
  const status = normalizeLifecycleStatus(input.status);
  if (['cancelled', 'completed', 'expired'].includes(status)) {
    return {
      canCancel: false, bookingTotal: input.bookingTotal, cancellationFee: input.bookingTotal,
      refundableAmount: 0, currency: input.currency, reason: `Booking is already ${status}.`
    };
  }
  const hoursBeforeStart = (new Date(input.startsAt).getTime() - new Date(input.now).getTime()) / 3_600_000;
  if (hoursBeforeStart <= 0) {
    return {
      canCancel: false, bookingTotal: input.bookingTotal, cancellationFee: input.bookingTotal,
      refundableAmount: 0, currency: input.currency, reason: 'Booking has already started.'
    };
  }
  const matching = [...input.rules]
    .sort((left, right) => right.minimumHoursBeforeStart - left.minimumHoursBeforeStart)
    .find((rule) => hoursBeforeStart >= rule.minimumHoursBeforeStart);
  const refundBasisPoints = matching?.refundBasisPoints ?? (input.rules.length || input.bookingProvider === 'regiondo' ? 0 : 10_000);
  const refundableAmount = percentageOf(input.bookingTotal, refundBasisPoints);
  return {
    canCancel: true,
    bookingTotal: input.bookingTotal,
    cancellationFee: input.bookingTotal - refundableAmount,
    refundableAmount,
    currency: input.currency,
    reason: matching?.reason ?? (input.bookingProvider === 'regiondo' && !input.rules.length
      ? 'Refund amount requires confirmation from the external provider.'
      : input.rules.length ? 'Cancellation policy threshold applied.' : 'No restrictive cancellation policy applies.')
  };
}

export async function getCancellationQuote(bookingId: string): Promise<CancellationQuote> {
  const result = await pool.query<{
    status: string; booking_provider: 'core' | 'regiondo'; dt_from: string; currency: string; total_minor: string | number; rules: unknown;
  }>(
    `SELECT booking.status, booking.booking_provider, booking.dt_from, booking.currency,
            COALESCE(SUM(item.subtotal_gross), ROUND(booking.total_amount * 100)::bigint, 0) AS total_minor,
            COALESCE(booking.cancellation_policy_snapshot, policy.rules, '[]'::jsonb) AS rules
     FROM bookings booking
     LEFT JOIN booking_items item ON item.booking_id = booking.booking_id
     LEFT JOIN products product ON product.product_id = item.product_id
     LEFT JOIN product_variants variant ON variant.variant_id = item.product_variant_id
     LEFT JOIN cancellation_policies policy ON policy.cancellation_policy_id = COALESCE(variant.cancellation_policy_id, product.cancellation_policy_id)
     WHERE booking.booking_id = $1
     GROUP BY booking.booking_id, policy.rules
     LIMIT 1`,
    [bookingId]
  );
  if (!result.rowCount) throw new Error('Booking was not found.');
  const row = result.rows[0];
  const rules = Array.isArray(row.rules) ? row.rules.filter(isCancellationRule) : [];
  return calculateCancellationQuote({
    bookingTotal: Number(row.total_minor), currency: row.currency, startsAt: row.dt_from,
    now: new Date().toISOString(), status: row.status, bookingProvider: row.booking_provider, rules
  });
}

function isCancellationRule(value: unknown): value is CancellationRule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CancellationRule>;
  return Number.isFinite(candidate.minimumHoursBeforeStart) && Number.isInteger(candidate.refundBasisPoints) &&
    (candidate.refundBasisPoints ?? -1) >= 0 && (candidate.refundBasisPoints ?? 10_001) <= 10_000;
}

export async function requestCancellation(bookingId: string): Promise<{ status: 'cancelled' | 'cancel_requested'; quote: CancellationQuote }> {
  const quote = await getCancellationQuote(bookingId);
  if (!quote.canCancel) {
    const current = await pool.query<{ status: string }>(`SELECT status FROM bookings WHERE booking_id = $1`, [bookingId]);
    if (current.rowCount && normalizeLifecycleStatus(current.rows[0].status) === 'cancelled') {
      return { status: 'cancelled', quote };
    }
    throw new BookingNotCancellableError(quote.reason);
  }
  return withTransaction(async (client) => {
    const booking = await client.query<{ booking_provider: string }>(
      `SELECT booking_provider FROM bookings WHERE booking_id = $1 FOR UPDATE`,
      [bookingId]
    );
    const paid = await client.query<{ payment_count: string | number }>(
      `SELECT COUNT(*) AS payment_count FROM payments
       WHERE booking_id = $1 AND status IN ('succeeded', 'partially_refunded')`,
      [bookingId]
    );
    const requiresRefund = quote.refundableAmount > 0 && Number(paid.rows[0].payment_count) > 0;
    const requiresProviderCancellation = booking.rows[0]?.booking_provider === 'regiondo';
    if (requiresRefund || requiresProviderCancellation) {
      await transitionBookingInTransaction(client, bookingId, 'cancel_requested', { refundableAmount: quote.refundableAmount });
      return { status: 'cancel_requested' as const, quote };
    }
    await transitionBookingInTransaction(client, bookingId, 'cancelled', { refundableAmount: 0 });
    await client.query(`DELETE FROM consumptions WHERE booking_id = $1 AND dt_to > now()`, [bookingId]);
    await client.query(
      `UPDATE access_credentials SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
       WHERE booking_id = $1 AND status IN ('pending', 'active')`,
      [bookingId]
    );
    await client.query(
      `UPDATE reservation_holds SET status = 'released', updated_at = now()
       WHERE booking_id = $1 AND status = 'active'`,
      [bookingId]
    );
    return { status: 'cancelled' as const, quote };
  });
}

