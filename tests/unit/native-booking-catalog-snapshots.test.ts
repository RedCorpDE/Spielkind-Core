import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachReservationHold: vi.fn(),
  clientQuery: vi.fn(),
  quoteWithClient: vi.fn()
}));

vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: async (fn: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
    fn({ query: mocks.clientQuery })
}));
vi.mock('../../src/modules/availability/reservation-hold.service.js', () => ({
  attachReservationHold: mocks.attachReservationHold
}));
vi.mock('../../src/modules/pricing/pricing.service.js', () => ({
  quoteWithClient: mocks.quoteWithClient
}));

const { createNativeBooking } = await import('../../src/modules/bookings/native-booking.service.js');

describe('native booking catalog snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.quoteWithClient.mockResolvedValue({
      items: [{
        productId: '11111111-1111-1111-1111-111111111111',
        variantId: '22222222-2222-2222-2222-222222222222',
        productName: 'LAN Session',
        variantName: '8 Hours',
        quantity: 1,
        unitPriceNet: 3193,
        unitPriceGross: 3800,
        vatBasisPoints: 1900,
        subtotalNet: 3193,
        tax: 607,
        subtotalGross: 3800,
        currency: 'EUR',
        options: [{ optionId: '33333333-3333-3333-3333-333333333333', name: 'Headset Rental', value: 'Included', priceDelta: 300 }]
      }],
      subtotalNet: 3193, tax: 607, subtotalGross: 3800, discount: 0, total: 3800, currency: 'EUR'
    });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM bookings WHERE idempotency_key')) return { rowCount: 0, rows: [] };
      if (sql.includes('COALESCE(offering.booking_provider')) {
        return { rowCount: 1, rows: [{ booking_provider: 'core', product_offering_id: null }] };
      }
      if (sql.includes('FROM reservation_holds WHERE')) {
        return {
          rowCount: 1,
          rows: [{
            client_id: '44444444-4444-4444-4444-444444444444',
            location_id: '55555555-5555-5555-5555-555555555555',
            product_id: '11111111-1111-1111-1111-111111111111',
            product_offering_id: null,
            product_variant_id: '22222222-2222-2222-2222-222222222222',
            quantity: 1,
            starts_at: '2026-10-10T18:00:00.000Z',
            ends_at: '2026-10-10T22:00:00.000Z'
          }]
        };
      }
      if (sql.includes('COALESCE(variant_policy.rules')) return { rowCount: 1, rows: [{ rules: [] }] };
      if (sql.includes('INSERT INTO bookings')) return { rowCount: 1, rows: [{ booking_id: '66666666-6666-6666-6666-666666666666' }] };
      if (sql.includes('INSERT INTO booking_items')) return { rowCount: 1, rows: [{ booking_item_id: '77777777-7777-7777-7777-777777777777' }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it('writes immutable Variant and Option names, values, and money snapshots', async () => {
    await createNativeBooking({
      productId: '11111111-1111-1111-1111-111111111111',
      variantId: '22222222-2222-2222-2222-222222222222',
      options: [{ optionId: '33333333-3333-3333-3333-333333333333', value: 'Included' }],
      quantity: 1,
      clientId: '44444444-4444-4444-4444-444444444444',
      locationId: '55555555-5555-5555-5555-555555555555',
      startsAt: '2026-10-10T18:00:00.000Z',
      endsAt: '2026-10-10T22:00:00.000Z',
      holdId: '88888888-8888-8888-8888-888888888888',
      idempotencyKey: 'catalog-snapshot-test'
    });

    const itemWrite = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO booking_items'));
    const optionWrite = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO booking_item_options'));
    expect(itemWrite?.[1]).toEqual(expect.arrayContaining(['LAN Session', '8 Hours', 3193, 3800, 607, 'EUR']));
    expect(optionWrite?.[1]).toEqual(expect.arrayContaining(['Headset Rental', 'Included', 300, 'EUR']));
  });
});

