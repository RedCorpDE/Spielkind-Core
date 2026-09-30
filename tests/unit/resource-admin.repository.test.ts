import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ pool: { query: poolQuery } }));

const { archiveAdminResource, createAdminResource } = await import('../../src/modules/resources/resource-admin.repository.js');

const resourceRow = {
  resource_id: 'resource-1', location_id: 'location-1', type: 'other', capacity_available: 10,
  title: 'Gaming PCs', description: null, image_url: null, independently_bookable: false,
  base_amount: '0', operational_status: 'active', created_at: '2026-09-29T10:00:00.000Z',
  updated_at: '2026-09-29T10:00:00.000Z', used_by_offerings: []
};

describe('Resource administration', () => {
  beforeEach(() => poolQuery.mockReset());

  it('rejects an unknown Location without creating a Resource', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(createAdminResource({
      locationId: 'missing', type: 'other', capacityAvailable: 1, title: 'Room'
    })).resolves.toBeNull();
  });

  it('deactivates instead of deleting historical Resource data', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ resource_id: 'resource-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...resourceRow, operational_status: 'out_of_service' }] });
    await expect(archiveAdminResource('resource-1')).resolves.toMatchObject({ operationalStatus: 'out_of_service' });
    expect(poolQuery.mock.calls[0][0]).toContain("UPDATE resources SET operational_status = 'out_of_service'");
    expect(poolQuery.mock.calls[0][0]).not.toContain('DELETE FROM resources');
  });
});
