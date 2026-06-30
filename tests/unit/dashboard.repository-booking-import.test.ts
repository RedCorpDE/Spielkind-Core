import { describe, expect, it, vi } from 'vitest';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID
} from '../../src/sync/mappers.js';
import { upsertNormalizedRegiondoBooking } from '../../src/modules/bookings/booking.repository.js';
import type { NormalizedRegiondoBookingImport } from '../../src/modules/bookings/booking-normalizer.js';

const bookingId = '11111111-1111-1111-1111-111111111111';
const clientId = '22222222-2222-2222-2222-222222222222';
const providerLocationId = '33333333-3333-3333-3333-333333333333';
const noLocationId = '44444444-4444-4444-4444-444444444444';
const productId = '55555555-5555-5555-5555-555555555555';

const normalizedBooking: NormalizedRegiondoBookingImport = {
  bookingKey: 'booking-key-1',
  client: {
    email: 'family@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: null,
    raw: null,
    regiondoCustomerId: 'regiondo-customer-1'
  },
  dtFrom: '2026-05-10T16:00:00.000Z',
  dtTo: '2026-05-10T18:00:00.000Z',
  guestCount: 2,
  items: [
    {
      quantity: 2,
      raw: null,
      regiondoProductId: 'regiondo-product-1',
      title: 'Workshop',
      unitPrice: 20
    }
  ],
  location: {
    raw: null,
    regiondoLocationId: 'regiondo-location-1',
    title: 'Berlin Mitte'
  },
  orderNumber: 'order-1',
  paidAmount: 20,
  payments: [],
  raw: null,
  snapshotGeneratedAt: '2026-05-01T10:00:00.000Z',
  status: 'confirmed',
  totalAmount: 40
};

describe('Regiondo booking import location overrides', () => {
  it('preserves an admin no-location override during normalized imports', async () => {
    const queryMock = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO clients')) {
        return { rowCount: 1, rows: [{ client_id: clientId }] };
      }

      if (sql.includes('INSERT INTO locations') && values?.[0] === SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID) {
        return { rowCount: 1, rows: [{ location_id: noLocationId }] };
      }

      if (sql.includes('INSERT INTO locations')) {
        return { rowCount: 1, rows: [{ location_id: providerLocationId }] };
      }

      if (sql.includes('SELECT admin.location_override')) {
        return { rowCount: 1, rows: [{ location_override: 'none' }] };
      }

      if (sql.includes('INSERT INTO bookings')) {
        return { rowCount: 1, rows: [{ booking_id: bookingId }] };
      }

      if (sql.includes('INSERT INTO products')) {
        return { rowCount: 1, rows: [{ product_id: productId }] };
      }

      return { rowCount: 0, rows: [] };
    });

    await upsertNormalizedRegiondoBooking({ query: queryMock } as never, normalizedBooking);

    const bookingInsert = queryMock.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO bookings'));
    expect(bookingInsert?.[1]?.[1]).toBe(noLocationId);
  });
});
