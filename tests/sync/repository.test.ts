import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RegiondoProduct, RegiondoBooking } from '../../src/sync/types.js';

// Mock the DB pool before importing repository so no real connection is attempted.
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockPoolConnect = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  pool: {
    query: mockQuery,
    connect: mockPoolConnect
  }
}));

// Import under test after mocks are in place.
const { upsertProductWithDetails, upsertBookingFromWebhook } = await import('../../src/sync/repository.js');

const baseProduct: RegiondoProduct = {
  id: 'prod-1',
  title: 'Laser Tag Session',
  description: 'Fun for all ages',
  image_url: 'https://example.com/img.jpg',
  price: 19.99,
  variants: [{ id: 'var-1', title: 'Adult', price: 19.99 }],
  options: [{ id: 'opt-1', title: 'Duration', values: ['30min', '60min'] }]
};

const baseBooking: RegiondoBooking = {
  id: 'booking-1',
  status: 'confirmed',
  start_date: '2026-06-01T10:00:00Z',
  end_date: '2026-06-01T11:00:00Z',
  total_price: 59.97,
  paid_amount: 59.97,
  guest_count: 3,
  customer: { id: 'cust-42' },
  location: { id: 'loc-7' },
  products: [{ id: 'prod-1', quantity: 3, price: 19.99 }]
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertProductWithDetails', () => {
  it('upserts the product and its variants and options', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await upsertProductWithDetails(baseProduct);

    // product upsert + delete variants + delete options + insert variant + insert option = 5 queries
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('first query is the product INSERT ... ON CONFLICT upsert', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await upsertProductWithDetails(baseProduct);

    const firstCall = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(firstCall[0]).toMatch(/INSERT INTO products/i);
    expect(firstCall[0]).toMatch(/ON CONFLICT/i);
  });

  it('deletes existing variants before re-inserting', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await upsertProductWithDetails(baseProduct);

    const calls = mockQuery.mock.calls.map((c) => (c as [string, unknown[]])[0]);
    expect(calls.some((q) => /DELETE FROM product_variants/i.test(q))).toBe(true);
  });

  it('handles a product with no variants or options without throwing', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const noExtrasProduct: RegiondoProduct = { id: 'prod-2', title: 'Simple' };

    await expect(upsertProductWithDetails(noExtrasProduct)).resolves.toBeUndefined();

    // product upsert + delete variants + delete options = 3 queries (no variant/option inserts)
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('propagates database errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(upsertProductWithDetails(baseProduct)).rejects.toThrow('DB connection lost');
  });
});

describe('upsertBookingFromWebhook', () => {
  function setupTransactionMocks({
    existingClientId,
    existingLocationId,
    bookingId,
    existingProductId
  }: {
    existingClientId?: string;
    existingLocationId?: string;
    bookingId?: string;
    existingProductId?: string;
  } = {}) {
    const clientQuery = vi.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release: mockRelease });

    let callCount = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      callCount++;
      const s = sql as string;
      if (s.includes('BEGIN') || s.includes('COMMIT') || s.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      // findOrCreateClient
      if (s.includes('SELECT client_id FROM clients')) {
        return existingClientId
          ? { rows: [{ client_id: existingClientId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (s.includes("INSERT INTO clients") && !s.includes('booking')) {
        return { rows: [{ client_id: existingClientId ?? 'new-client-id' }], rowCount: 1 };
      }
      // findOrCreateLocation
      if (s.includes('SELECT location_id FROM locations')) {
        return existingLocationId
          ? { rows: [{ location_id: existingLocationId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (s.includes('INSERT INTO locations')) {
        return { rows: [{ location_id: existingLocationId ?? 'new-location-id' }], rowCount: 1 };
      }
      // booking upsert
      if (s.includes('INSERT INTO bookings')) {
        return { rows: [{ booking_id: bookingId ?? 'new-booking-id' }], rowCount: 1 };
      }
      // delete booking_products
      if (s.includes('DELETE FROM booking_products')) {
        return { rows: [], rowCount: 0 };
      }
      // product lookup for booking_products
      if (s.includes('SELECT product_id FROM products')) {
        return existingProductId
          ? { rows: [{ product_id: existingProductId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // booking_products insert
      if (s.includes('INSERT INTO booking_products')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    return { clientQuery };
  }

  it('wraps the operation in a transaction (BEGIN / COMMIT)', async () => {
    const { clientQuery } = setupTransactionMocks({ existingClientId: 'c1', existingLocationId: 'l1', bookingId: 'b1', existingProductId: 'p1' });

    await upsertBookingFromWebhook(baseBooking);

    const sqls = clientQuery.mock.calls.map((c) => (c as [string])[0]);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
  });

  it('releases the pool client after success', async () => {
    setupTransactionMocks({ existingClientId: 'c1', existingLocationId: 'l1', bookingId: 'b1' });

    await upsertBookingFromWebhook(baseBooking);

    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('rolls back and re-throws on error', async () => {
    const clientQuery = vi.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release: mockRelease });

    let call = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      call++;
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      throw new Error('unexpected DB failure');
    });

    await expect(upsertBookingFromWebhook(baseBooking)).rejects.toThrow('unexpected DB failure');
    const sqls = clientQuery.mock.calls.map((c) => (c as [string])[0]);
    expect(sqls).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('handles a booking with unknown customer (null customer id)', async () => {
    const clientQuery = vi.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release: mockRelease });

    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if ((sql as string).includes('INSERT INTO clients')) return { rows: [{ client_id: 'anon-client' }], rowCount: 1 };
      if ((sql as string).includes('SELECT location_id')) return { rows: [{ location_id: 'loc-1' }], rowCount: 1 };
      if ((sql as string).includes('INSERT INTO bookings')) return { rows: [{ booking_id: 'b-anon' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const bookingNoCustomer: RegiondoBooking = { ...baseBooking, customer: undefined, products: [] };
    await expect(upsertBookingFromWebhook(bookingNoCustomer)).resolves.toBeUndefined();
  });
});
