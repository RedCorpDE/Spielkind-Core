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
      .mockResolvedValueOnce({ rows: [{
        offering_location_id: 'location-a', resource_location_id: 'location-a', booking_provider: 'core'
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{
        product_offering_id: 'offering', product_id: 'product', product_title: 'LAN Session',
        location_id: 'location-a', location_title: 'Braunschweig', resource_id: 'resource',
        resource_title: 'Gaming PCs', quantity: 2, scaling_mode: 'per_quantity'
      }] });
    await expect(upsertOfferingResource({ offeringId: 'offering', resourceId: 'resource', quantity: 2 }))
      .resolves.toMatchObject({ quantity: 2, scalingMode: 'per_quantity', locationId: 'location-a' });
    expect(mocks.clientQuery.mock.calls[1][0]).toContain('ON CONFLICT (product_offering_id, resource_id)');
  });

  it('stores per-booking scaling for a Core Offering', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{
        offering_location_id: 'location-a', resource_location_id: 'location-a', booking_provider: 'core'
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{
        product_offering_id: 'offering', product_id: 'product', product_title: 'LAN Flat',
        location_id: 'location-a', location_title: 'Braunschweig', resource_id: 'flat',
        resource_title: 'LAN Flat A', quantity: 1, scaling_mode: 'per_booking'
      }] });
    await expect(upsertOfferingResource({
      offeringId: 'offering', resourceId: 'flat', quantity: 1, scalingMode: 'per_booking'
    })).resolves.toMatchObject({ quantity: 1, scalingMode: 'per_booking' });
    expect(mocks.clientQuery.mock.calls[1][1]).toEqual(['offering', 'flat', 1, 'per_booking']);
  });

  it('does not enable Core scaling semantics for Regiondo Offerings', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{
      offering_location_id: 'location-a', resource_location_id: 'location-a', booking_provider: 'regiondo'
    }] });
    await expect(upsertOfferingResource({
      offeringId: 'offering', resourceId: 'resource', quantity: 1, scalingMode: 'per_booking'
    })).resolves.toBe('provider_managed_scaling');
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
  });
});
