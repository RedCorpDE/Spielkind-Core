import { describe, expect, it } from 'vitest';
import { aggregateRegiondoBookingStatus, mapRegiondoBookingStatus } from '../../src/modules/bookings/booking-status.mapper.js';

describe('mapRegiondoBookingStatus', () => {
  it('maps confirmed-like Regiondo statuses to confirmed', () => {
    expect(mapRegiondoBookingStatus({ status: 'approved' })).toBe('confirmed');
    expect(mapRegiondoBookingStatus({ status: 'confirmed' })).toBe('confirmed');
  });

  it('maps processing directly', () => {
    expect(mapRegiondoBookingStatus({ status: 'processing' })).toBe('processing');
  });

  it('maps cancellation variants to canceled', () => {
    expect(mapRegiondoBookingStatus({ status: 'cancelled' })).toBe('canceled');
    expect(mapRegiondoBookingStatus({ status: 'canceled' })).toBe('canceled');
    expect(mapRegiondoBookingStatus({ status: 'approved', quantity: 2, quantityCancelled: 2 })).toBe('canceled');
  });

  it('maps rejected directly and unknowns defensively', () => {
    expect(mapRegiondoBookingStatus({ status: 'rejected' })).toBe('rejected');
    expect(mapRegiondoBookingStatus({ status: 'mystery-status' })).toBe('unknown');
  });
});

describe('aggregateRegiondoBookingStatus', () => {
  it('prefers confirmed when any booking is confirmed and none are processing', () => {
    expect(
      aggregateRegiondoBookingStatus([
        { booking_key: 'a', order_number: '1', status: 'approved' },
        { booking_key: 'a', order_number: '1', status: 'pending' }
      ])
    ).toBe('confirmed');
  });

  it('returns canceled only when every supplier booking is canceled', () => {
    expect(
      aggregateRegiondoBookingStatus([
        { booking_key: 'a', order_number: '1', status: 'canceled' },
        { booking_key: 'a', order_number: '1', status: 'cancelled' }
      ])
    ).toBe('canceled');
  });
});
