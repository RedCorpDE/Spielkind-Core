import { describe, expect, it } from 'vitest';
import { assertBookingTransition, canTransitionBooking } from '../../src/modules/bookings/booking-lifecycle.service.js';
import { InvalidBookingTransitionError } from '../../src/modules/bookings/booking.errors.js';

describe('booking lifecycle', () => {
  it('accepts valid payment and attendance transitions', () => {
    expect(canTransitionBooking('payment_pending', 'confirmed')).toBe(true);
    expect(canTransitionBooking('confirmed', 'checked_in')).toBe(true);
    expect(canTransitionBooking('checked_in', 'completed')).toBe(true);
  });

  it('rejects arbitrary state changes', () => {
    expect(() => assertBookingTransition('completed', 'confirmed')).toThrow(InvalidBookingTransitionError);
    expect(() => assertBookingTransition('cancelled', 'payment_pending')).toThrow(InvalidBookingTransitionError);
  });
});

