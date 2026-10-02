import { describe, expect, it } from 'vitest';
import {
  assertBookingPaymentCombination,
  assertPaymentTransition,
  canTransitionPayment,
  getAllowedPaymentTransitions
} from '../../src/modules/payments/payment-lifecycle.service.js';
import {
  InvalidBookingPaymentStateError,
  InvalidPaymentTransitionError
} from '../../src/modules/bookings/booking.errors.js';

describe('payment lifecycle', () => {
  it('accepts payment, retry, and refund transitions', () => {
    expect(canTransitionPayment('unpaid', 'processing')).toBe(true);
    expect(canTransitionPayment('failed', 'paid')).toBe(true);
    expect(canTransitionPayment('paid', 'partially_refunded')).toBe(true);
    expect(getAllowedPaymentTransitions('partially_refunded')).toContain('refunded');
  });

  it('rejects impossible payment transitions', () => {
    expect(() => assertPaymentTransition('refunded', 'paid')).toThrow(InvalidPaymentTransitionError);
    expect(() => assertPaymentTransition('unpaid', 'refunded')).toThrow(InvalidPaymentTransitionError);
  });

  it('makes intentionally supported booking/payment combinations explicit', () => {
    expect(() => assertBookingPaymentCombination('confirmed', 'unpaid')).not.toThrow();
    expect(() => assertBookingPaymentCombination('cancelled', 'paid')).not.toThrow();
    expect(() => assertBookingPaymentCombination('completed', 'refunded')).not.toThrow();
    expect(() => assertBookingPaymentCombination('payment_failed', 'paid'))
      .toThrow(InvalidBookingPaymentStateError);
    expect(() => assertBookingPaymentCombination('confirmed', 'failed'))
      .toThrow(InvalidBookingPaymentStateError);
  });
});
