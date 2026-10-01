import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clientQuery: vi.fn(), transitionBooking: vi.fn() }));

vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: async (work: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
    work({ query: mocks.clientQuery })
}));
vi.mock('../../src/modules/bookings/booking-lifecycle.service.js', () => ({
  transitionBookingInTransaction: mocks.transitionBooking
}));

const { confirmStripePayment } = await import('../../src/modules/payments/payment-confirmation.service.js');

describe('Core payment confirmation Resource consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM payments') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{
        payment_id: 'payment', booking_id: 'booking', status: 'processing',
        amount_minor: 12000, currency: 'EUR', provider_payment_id: null, provider_checkout_id: 'checkout'
      }] };
      if (sql.includes('FROM bookings WHERE')) return { rowCount: 1, rows: [{
        booking_id: 'booking', status: 'payment_pending',
        dt_from: '2026-10-10T16:00:00.000Z', dt_to: '2026-10-12T10:00:00.000Z',
        total_minor: 12000, currency: 'EUR'
      }] };
      if (sql.includes('FROM reservation_holds')) return { rowCount: 1, rows: [{
        reservation_hold_id: 'hold', status: 'active'
      }] };
      if (sql.includes('FROM reservation_hold_allocations')) return { rowCount: 1, rows: [{
        resource_id: 'flat', capacity_used: 1
      }] };
      if (sql.includes('FROM resources')) return { rowCount: 1, rows: [{
        resource_id: 'flat', title: 'LAN Flat A', capacity_available: 1, operational_status: 'active'
      }] };
      if (sql.includes(' AS used')) return { rowCount: 1, rows: [{ used: 0 }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it('copies the fixed hold allocation into the confirmed booking consumption', async () => {
    await expect(confirmStripePayment({
      bookingId: 'booking', providerCheckoutId: 'checkout', providerPaymentId: 'stripe-payment',
      amountMinor: 12000, currency: 'EUR', externalEventId: 'event', eventType: 'checkout.session.completed'
    })).resolves.toMatchObject({ status: 'confirmed', consumptionsCreated: 1 });

    const insert = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO consumptions'));
    expect(insert?.[1]?.[4]).toBe(1);
  });
});
