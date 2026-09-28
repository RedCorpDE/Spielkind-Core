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

