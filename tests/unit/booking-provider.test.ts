import { describe, expect, it } from 'vitest';
import { bookingProviderRegistry, getBookingProvider } from '../../src/modules/bookings/booking-provider.js';

describe('booking provider registry', () => {
  it('keeps Regiondo behind the provider boundary', () => {
    const provider = bookingProviderRegistry.get('regiondo');
    expect(provider.key).toBe('regiondo');
    expect(provider.getAvailability).toBeTypeOf('function');
    expect(provider.getBooking).toBeTypeOf('function');
    expect(provider.cancelBooking).toBeTypeOf('function');
  });

  it('resolves non-Regiondo legacy sources as Core bookings', () => {
    expect(getBookingProvider('manual').key).toBe('core');
    expect(getBookingProvider('app').key).toBe('core');
  });
});

