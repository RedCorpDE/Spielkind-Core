import { describe, expect, it } from 'vitest';
import { assertRefundWithinPayment, RefundAmountExceededError } from '../../src/modules/payments/refund.service.js';

describe('refund limits', () => {
  it('supports multiple partial refunds up to the payment total', () => {
    expect(() => assertRefundWithinPayment(10_000, 2_500, 5_000)).not.toThrow();
    expect(() => assertRefundWithinPayment(10_000, 7_500, 2_500)).not.toThrow();
  });

  it('rejects refunds above the original payment total', () => {
    expect(() => assertRefundWithinPayment(10_000, 7_500, 2_501)).toThrow(RefundAmountExceededError);
  });
});

