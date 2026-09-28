import { withTransaction } from '../../db/transaction.js';

export class RefundAmountExceededError extends Error {
  constructor() {
    super('Refund total cannot exceed the succeeded payment amount.');
    this.name = 'RefundAmountExceededError';
  }
}

export function assertRefundWithinPayment(paymentTotal: number, alreadyRefunded: number, requested: number): void {
  if (![paymentTotal, alreadyRefunded, requested].every(Number.isSafeInteger) || requested <= 0) {
    throw new TypeError('Refund amounts must be positive integer minor units.');
  }
  if (alreadyRefunded + requested > paymentTotal) throw new RefundAmountExceededError();
}

export async function recordRefund(input: {
  paymentId: string;
  bookingId: string;
  provider: 'stripe' | 'regiondo' | 'manual';
  providerRefundId?: string;
  amountMinor: number;
  currency: string;
  reason?: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  idempotencyKey: string;
}): Promise<{ refundId: string; created: boolean }> {
  return withTransaction(async (client) => {
    const duplicate = await client.query<{ refund_id: string }>(`SELECT refund_id FROM refunds WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (duplicate.rowCount) return { refundId: duplicate.rows[0].refund_id, created: false };
    const payment = await client.query<{ amount_minor: string | number; currency: string }>(
      `SELECT amount_minor, currency FROM payments WHERE payment_id = $1 AND booking_id = $2 FOR UPDATE`,
      [input.paymentId, input.bookingId]
    );
    if (!payment.rowCount) throw new Error('Payment was not found.');
    if (payment.rows[0].currency !== input.currency) throw new Error('Refund currency must match payment currency.');
    const refunded = await client.query<{ amount: string | number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM refunds
       WHERE payment_id = $1 AND status IN ('pending', 'processing', 'succeeded')`,
      [input.paymentId]
    );
    const newTotal = Number(refunded.rows[0].amount) + input.amountMinor;
    const paymentTotal = Number(payment.rows[0].amount_minor);
    assertRefundWithinPayment(paymentTotal, Number(refunded.rows[0].amount), input.amountMinor);
    const result = await client.query<{ refund_id: string }>(
      `INSERT INTO refunds (
         payment_id, booking_id, provider, provider_refund_id, amount_minor,
         currency, reason, status, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING refund_id`,
      [
        input.paymentId, input.bookingId, input.provider, input.providerRefundId ?? null,
        input.amountMinor, input.currency, input.reason ?? null, input.status, input.idempotencyKey
      ]
    );
    if (input.status === 'succeeded') {
      await client.query(
        `UPDATE bookings SET payment_status = CASE
           WHEN $2 >= ROUND(total_amount * 100)::bigint THEN 'refunded' ELSE 'partially_refunded' END,
           status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
         WHERE booking_id = $1`,
        [input.bookingId, newTotal]
      );
      await client.query(
        `UPDATE payments SET status = CASE WHEN $2 >= amount_minor THEN 'refunded' ELSE 'partially_refunded' END, updated_at = now()
         WHERE payment_id = $1`,
        [input.paymentId, newTotal]
      );
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('booking', $1, 'refund.completed', $2::jsonb)`,
        [input.bookingId, JSON.stringify({ bookingId: input.bookingId, refundId: result.rows[0].refund_id, amountMinor: input.amountMinor })]
      );
    }
    return { refundId: result.rows[0].refund_id, created: true };
  }, { isolationLevel: 'SERIALIZABLE' });
}

export async function updateStripeRefundState(input: {
  providerRefundId: string;
  status: 'succeeded' | 'failed';
  externalEventId: string;
}): Promise<{ bookingId: string } | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      refund_id: string; booking_id: string; payment_id: string; amount_minor: string | number;
    }>(
      `SELECT refund_id, booking_id, payment_id, amount_minor FROM refunds
       WHERE provider = 'stripe' AND provider_refund_id = $1 LIMIT 1 FOR UPDATE`,
      [input.providerRefundId]
    );
    const refund = result.rows[0];
    if (!refund) return null;
    await client.query(
      `UPDATE refunds SET status = $2, metadata = metadata || $3::jsonb, updated_at = now() WHERE refund_id = $1`,
      [refund.refund_id, input.status, JSON.stringify({ lastStripeEventId: input.externalEventId })]
    );
    if (input.status === 'failed') {
      await client.query(`UPDATE bookings SET payment_status = 'refund_failed', updated_at = now() WHERE booking_id = $1`, [refund.booking_id]);
    } else {
      const totals = await client.query<{ refunded: string | number; payment_total: string | number }>(
        `SELECT COALESCE(SUM(refund_record.amount_minor) FILTER (WHERE refund_record.status = 'succeeded'), 0) AS refunded,
                payment.amount_minor AS payment_total
         FROM payments payment LEFT JOIN refunds refund_record ON refund_record.payment_id = payment.payment_id
         WHERE payment.payment_id = $1 GROUP BY payment.amount_minor`,
        [refund.payment_id]
      );
      const refunded = Number(totals.rows[0]?.refunded ?? 0);
      const paymentTotal = Number(totals.rows[0]?.payment_total ?? 0);
      const state = refunded >= paymentTotal ? 'refunded' : 'partially_refunded';
      await client.query(`UPDATE payments SET status = $2, updated_at = now() WHERE payment_id = $1`, [refund.payment_id, state]);
      await client.query(
        `UPDATE bookings SET payment_status = $2, status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
         WHERE booking_id = $1`,
        [refund.booking_id, state]
      );
      await client.query(
        `INSERT INTO web_audit_events (action, actor_type, booking_id, details)
         VALUES ('stripe.refund.complete', 'stripe', $1, $2::jsonb)`,
        [refund.booking_id, JSON.stringify({ refundId: refund.refund_id, amountMinor: Number(refund.amount_minor) })]
      );
    }
    return { bookingId: refund.booking_id };
  });
}

