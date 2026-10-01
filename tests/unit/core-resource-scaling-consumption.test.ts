import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clientQuery: vi.fn(), loadResourceRequirements: vi.fn() }));

vi.mock('../../src/db/pool.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: async (work: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
    work({ query: mocks.clientQuery })
}));
vi.mock('../../src/modules/resources/resource-requirements.repository.js', () => ({
  loadResourceRequirements: mocks.loadResourceRequirements
}));

const { rebuildConsumptionsForBooking } = await import('../../src/modules/resources/consumption.service.js');

describe('Core per-booking consumption rebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadResourceRequirements.mockResolvedValue([{
      resource_id: '33333333-3333-3333-3333-333333333333',
      resource_title: 'LAN Flat A', capacity_available: 1,
      quantity: 1, scaling_mode: 'per_booking', required_quantity: 1, source: 'offering'
    }]);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM bookings')) return { rowCount: 1, rows: [{
        booking_id: '11111111-1111-1111-1111-111111111111',
        location_id: '22222222-2222-2222-2222-222222222222',
        status: 'confirmed', dt_from: '2026-10-10T16:00:00.000Z', dt_to: '2026-10-12T10:00:00.000Z'
      }] };
      if (sql.includes('FROM booking_products')) return { rowCount: 1, rows: [{ product_id: 'product', quantity: 5 }] };
      if (sql.includes('LEFT JOIN consumptions')) return { rowCount: 1, rows: [{
        resource_id: '33333333-3333-3333-3333-333333333333',
        capacity_available: 1, capacity_reserved: 0
      }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it('creates one unit of confirmed capacity for a five-participant booking', async () => {
    await expect(rebuildConsumptionsForBooking('11111111-1111-1111-1111-111111111111'))
      .resolves.toMatchObject({ consumptionsCreated: 1 });
    expect(mocks.loadResourceRequirements).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 5 }));
    const insert = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO consumptions'));
    expect(insert?.[1]?.[4]).toBe(1);
  });
});
