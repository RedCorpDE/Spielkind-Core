import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  loadManualBlockCapacities: vi.fn(),
  loadResourceRequirements: vi.fn(),
  poolQuery: vi.fn(),
  rulesAllow: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({ pool: { query: mocks.poolQuery } }));
vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: async (work: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
    work({ query: mocks.clientQuery })
}));
vi.mock('../../src/modules/resources/resource-requirements.repository.js', () => ({
  loadResourceRequirements: mocks.loadResourceRequirements
}));
vi.mock('../../src/modules/resources/availability-rule.repository.js', () => ({
  isIntervalAllowedByAvailabilityRules: mocks.rulesAllow,
  loadManualBlockCapacities: mocks.loadManualBlockCapacities
}));

const { getAvailability } = await import('../../src/modules/resources/availability.service.js');
const { createReservationHold } = await import('../../src/modules/availability/reservation-hold.service.js');

const interval = {
  location_id: '11111111-1111-1111-1111-111111111111',
  product_id: '22222222-2222-2222-2222-222222222222',
  dt_from: '2026-10-10T16:00:00.000Z',
  dt_to: '2026-10-12T10:00:00.000Z',
  guest_count: 3
};

describe('Core per-booking Resource availability and holds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rulesAllow.mockResolvedValue(true);
    mocks.loadManualBlockCapacities.mockResolvedValue(new Map());
    mocks.loadResourceRequirements.mockResolvedValue([{
      resource_id: '33333333-3333-3333-3333-333333333333',
      resource_title: 'LAN Flat A',
      capacity_available: 1,
      quantity: 1,
      scaling_mode: 'per_booking',
      required_quantity: 1,
      source: 'offering'
    }]);
  });

  it('uses one unit for three participants and becomes unavailable during an overlapping hold', async () => {
    let heldCapacity = 0;
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('LEFT JOIN consumptions')) {
        return { rows: [{
          resource_id: '33333333-3333-3333-3333-333333333333',
          capacity_available: 1,
          capacity_reserved: 0
        }] };
      }
      if (sql.includes('FROM reservation_hold_allocations')) {
        return { rows: heldCapacity ? [{
          resource_id: '33333333-3333-3333-3333-333333333333',
          capacity_held: heldCapacity
        }] : [] };
      }
      throw new Error(`Unexpected availability query: ${sql}`);
    });

    await expect(getAvailability(interval)).resolves.toMatchObject([{
      required_quantity: 1,
      capacity_held: 0,
      is_available: true
    }]);
    expect(mocks.loadResourceRequirements).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 3 }));

    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE idempotency_key')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT resource_id FROM resources')) return { rowCount: 1, rows: [{ resource_id: '33333333-3333-3333-3333-333333333333' }] };
      if (sql.includes(' AS used')) return { rowCount: 1, rows: [{ used: 0 }] };
      if (sql.includes('INSERT INTO reservation_holds')) {
        return { rowCount: 1, rows: [{ reservation_hold_id: '44444444-4444-4444-4444-444444444444' }] };
      }
      if (sql.includes('INSERT INTO reservation_hold_allocations')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT reservation_hold_id, status, expires_at')) {
        return { rowCount: 1, rows: [{
          reservation_hold_id: '44444444-4444-4444-4444-444444444444',
          status: 'active', expires_at: '2026-10-01T12:15:00.000Z'
        }] };
      }
      if (sql.includes('SELECT resource_id, capacity_used')) {
        return { rowCount: 1, rows: [{
          resource_id: '33333333-3333-3333-3333-333333333333', capacity_used: 1
        }] };
      }
      throw new Error(`Unexpected hold query: ${sql}`);
    });

    const hold = await createReservationHold({
      locationId: interval.location_id,
      productId: interval.product_id,
      productOfferingId: '55555555-5555-5555-5555-555555555555',
      quantity: 3,
      startsAt: interval.dt_from,
      endsAt: interval.dt_to,
      expiresAt: '2026-10-01T12:15:00.000Z',
      idempotencyKey: 'flat-hold'
    });
    expect(hold.allocations).toEqual([{
      resourceId: '33333333-3333-3333-3333-333333333333', capacityUsed: 1
    }]);
    const allocationInsert = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO reservation_hold_allocations'));
    expect(allocationInsert?.[1]?.[2]).toBe(1);

    heldCapacity = 1;
    await expect(getAvailability(interval)).resolves.toMatchObject([{
      required_quantity: 1,
      capacity_held: 1,
      is_available: false
    }]);
  });
});
