import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clientQuery: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: vi.fn(async (work: (client: { query: typeof mocks.clientQuery }) => unknown) => work({ query: mocks.clientQuery }))
}));

const { upsertOfferingResource } = await import('../../src/modules/products/product-offering-resource.repository.js');

describe('Offering Resource writes', () => {
  beforeEach(() => mocks.clientQuery.mockReset());

  it('rejects a Resource owned by another Location before writing', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ offering_location_id: 'location-a', resource_location_id: 'location-b' }] });
    await expect(upsertOfferingResource({ offeringId: 'offering', resourceId: 'resource', quantity: 1 }))
      .resolves.toBe('wrong_location');
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
  });

  it('upserts one unique requirement for a same-Location Resource', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ offering_location_id: 'location-a', resource_location_id: 'location-a' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{
        product_offering_id: 'offering', product_id: 'product', product_title: 'LAN Session',
        location_id: 'location-a', location_title: 'Braunschweig', resource_id: 'resource',
        resource_title: 'Gaming PCs', quantity: 2
      }] });
    await expect(upsertOfferingResource({ offeringId: 'offering', resourceId: 'resource', quantity: 2 }))
      .resolves.toMatchObject({ quantity: 2, locationId: 'location-a' });
    expect(mocks.clientQuery.mock.calls[1][0]).toContain('ON CONFLICT (product_offering_id, resource_id)');
  });
});
