import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQuery, connect, poolQuery, release } = vi.hoisted(() => ({
  clientQuery: vi.fn(), connect: vi.fn(), poolQuery: vi.fn(), release: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: { connect, query: poolQuery }
}));

const { listLocations, listRegiondoLocationCandidates, mapLocationToRegiondo } = await import('../../src/dashboard/repository/locations.js');

const targetId = '11111111-1111-1111-1111-111111111111';
const sourceId = '22222222-2222-2222-2222-222222222222';
const row = (overrides: Record<string, unknown>) => ({
  location_id: targetId,
  title: 'Built-in Berlin',
  description: null,
  image_url: null,
  regiondo_location_id: null,
  created_at: '2026-08-11T10:00:00.000Z',
  updated_at: '2026-08-11T10:00:00.000Z',
  ...overrides
});

describe('Regiondo location mapping', () => {
  beforeEach(() => {
    clientQuery.mockReset();
    connect.mockReset();
    poolQuery.mockReset();
    release.mockReset();
    connect.mockResolvedValue({ query: clientQuery, release });
  });

  it('keeps the built-in location and moves provider-linked records before deleting the duplicate', async () => {
    clientQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM locations WHERE location_id') && sql.includes('regiondo_raw')) {
        return { rowCount: 1, rows: [row({ location_id: sourceId, title: 'Regiondo Berlin', regiondo_location_id: 'rd-berlin', regiondo_raw: { id: 'rd-berlin' } })] };
      }
      if (sql.includes('FROM locations WHERE location_id')) return { rowCount: 1, rows: [row({})] };
      if (sql.includes('SELECT booking_id FROM bookings')) return { rowCount: 1, rows: [{ booking_id: '33333333-3333-3333-3333-333333333333' }] };
      if (sql.includes('UPDATE locations') && sql.includes('RETURNING location_id')) {
        return { rowCount: 1, rows: [row({ title: 'Berlin Mitte', regiondo_location_id: 'rd-berlin' })] };
      }
      return { rowCount: 1, rows: [] };
    });

    const mapped = await mapLocationToRegiondo(targetId, { sourceLocationId: sourceId, title: 'Berlin Mitte' });

    expect(mapped).toMatchObject({ id: targetId, title: 'Berlin Mitte', regiondoLocationId: 'rd-berlin', providerDataStatus: 'known' });
    expect(clientQuery.mock.calls.some(([sql, values]) => sql.includes('UPDATE bookings SET location_id') && values[0] === targetId && values[1] === sourceId)).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('UPDATE resources SET location_id'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO location_products'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('UPDATE tasks') && sql.includes('booking_data'))).toBe(true);
    const clearSourceIndex = clientQuery.mock.calls.findIndex(([sql]) => sql.includes('SET regiondo_location_id = NULL'));
    const mapTargetIndex = clientQuery.mock.calls.findIndex(([sql]) => sql.includes('SET title = $2, regiondo_location_id = $3'));
    const deleteSourceIndex = clientQuery.mock.calls.findIndex(([sql]) => sql.includes('DELETE FROM locations'));
    expect(clearSourceIndex).toBeLessThan(mapTargetIndex);
    expect(mapTargetIndex).toBeLessThan(deleteSourceIndex);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('marks ordinary unmapped locations as Core-only provider data', async () => {
    poolQuery.mockResolvedValue({ rowCount: 1, rows: [row({})] });
    const locations = await listLocations();
    expect(locations[0].providerDataStatus).toBe('none');
  });

  it('only turns explicit catalog location IDs into Regiondo mapping candidates', async () => {
    poolQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{
        addresses: ['Kleine Burg 15, Braunschweig, Deutschland'],
        location_id: 'location-22',
        location_title: 'VirtuaLounge',
        location_names: ['VirtuaLounge']
      }]
    });

    await expect(listRegiondoLocationCandidates()).resolves.toEqual([{
      addresses: ['Kleine Burg 15, Braunschweig, Deutschland'],
      id: 'location-22',
      locationNames: ['VirtuaLounge'],
      title: 'VirtuaLounge'
    }]);
    expect(poolQuery.mock.calls[0][0]).toContain("regiondo_raw ->> 'location_id'");
    expect(poolQuery.mock.calls[0][0]).not.toContain("regiondo_raw ->> 'city_id' AS");
  });
});
