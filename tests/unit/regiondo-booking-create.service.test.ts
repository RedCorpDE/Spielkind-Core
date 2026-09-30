import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  purchaseOrder: vi.fn(),
  listSupplierBookings: vi.fn(),
  normalize: vi.fn(),
  importBooking: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({ pool: { query: mocks.poolQuery } }));
vi.mock('../../src/modules/regiondo/regiondo.client.js', () => ({
  regiondoClient: {
    purchaseOrder: mocks.purchaseOrder,
    listSupplierBookings: mocks.listSupplierBookings
  }
}));
vi.mock('../../src/modules/bookings/booking-normalizer.js', () => ({
  normalizeRegiondoBookingImport: mocks.normalize
}));
vi.mock('../../src/modules/bookings/booking.repository.js', () => ({
  importNormalizedRegiondoBooking: mocks.importBooking
}));

const { createRegiondoBooking } = await import(
  '../../src/modules/integrations/booking-providers/regiondo/regiondo-booking-create.service.js'
);

const input = {
  intent: {
    locationId: '11111111-1111-1111-1111-111111111111',
    productId: '22222222-2222-2222-2222-222222222222',
    locationProductId: '33333333-3333-3333-3333-333333333333',
    variantId: '44444444-4444-4444-4444-444444444444',
    startAt: '2026-10-16T16:00:00.000Z',
    endAt: '2026-10-16T18:00:00.000Z',
    participants: 4,
    options: []
  },
  clientId: '55555555-5555-5555-5555-555555555555',
  idempotencyKey: 'app:create:1',
  source: 'app' as const
};

describe('Regiondo booking provider creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          timezone: 'Europe/Berlin',
          external_product_id: '9001',
          external_variant_id: '720707',
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.com',
          phone_number: null
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mocks.purchaseOrder.mockResolvedValue({
      order_number: 'ORDER-1',
      items: [{ booking_key: 'BOOKING-1' }]
    });
    mocks.listSupplierBookings.mockResolvedValue([]);
    mocks.normalize.mockReturnValue({ bookingKey: 'BOOKING-1' });
    mocks.importBooking.mockResolvedValue({
      bookingId: '66666666-6666-6666-6666-666666666666'
    });
  });

  it('maps a normalized intent to Regiondo and imports the normalized booking', async () => {
    await expect(createRegiondoBooking(input)).resolves.toEqual({
      bookingId: '66666666-6666-6666-6666-666666666666',
      bookingIds: ['66666666-6666-6666-6666-666666666666'],
      created: true
    });

    expect(mocks.purchaseOrder).toHaveBeenCalledWith(expect.objectContaining({
      items: [{
        product_id: 9001,
        option_id: 720707,
        qty: 4,
        date_time: '2026-10-16 18:00:00'
      }],
      subId: input.idempotencyKey
    }));
    expect(mocks.importBooking).toHaveBeenCalledWith({ bookingKey: 'BOOKING-1' });
    const updateSql = String(mocks.poolQuery.mock.calls.at(-1)?.[0]);
    expect(updateSql).toContain('product_offering_id');
    expect(updateSql).not.toMatch(/booking_provider\s*=/i);
  });

  it('rejects an offering with no Regiondo product mapping before purchase', async () => {
    mocks.poolQuery.mockReset();
    mocks.poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          timezone: 'Europe/Berlin', external_product_id: null, external_variant_id: '720707',
          first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone_number: null
        }]
      });

    await expect(createRegiondoBooking(input)).rejects.toThrow('missing its Regiondo product mapping');
    expect(mocks.purchaseOrder).not.toHaveBeenCalled();
  });
});
