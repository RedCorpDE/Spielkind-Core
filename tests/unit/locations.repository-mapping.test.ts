import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQuery, connect, poolQuery, release } = vi.hoisted(() => ({
  clientQuery: vi.fn(), connect: vi.fn(), poolQuery: vi.fn(), release: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: { connect, query: poolQuery }
}));

const { createLocation, listLocations, listRegiondoLocationCandidates, mapLocationToRegiondo, updateLocation } = await import('../../src/dashboard/repository/locations.js');

const targetId = '11111111-1111-1111-1111-111111111111';
const sourceId = '22222222-2222-2222-2222-222222222222';
const row = (overrides: Record<string, unknown>) => ({
  location_id: targetId,
  title: 'Built-in Berlin',
  description: null,
  address: null,
  city: null,
  postal_code: null,
  country_code: 'DE',
  latitude: null,
  longitude: null,
  image_url: null,
  image_urls: [],
  directions: null,
  parking: null,
  public_transport: null,
  facilities: [],
  house_rules: [],
  contact_email: null,
  contact_phone: null,
  support_note: null,
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

  it('creates title-only locations with safe defaults', async () => {
    poolQuery.mockResolvedValue({ rowCount: 1, rows: [row({ title: 'Hamburg' })] });

    await expect(createLocation({ title: '  Hamburg  ' })).resolves.toMatchObject({
      title: 'Hamburg',
      countryCode: 'DE',
      imageUrls: [],
      facilities: [],
      houseRules: []
    });

    const [, values] = poolQuery.mock.calls[0];
    expect(values).toEqual([
      'Hamburg', null, null, null, null, 'DE', null, null, null, [], null, null, null, [], [], null, null, null, null
    ]);
  });

  it('normalizes full location details and treats imageUrls as authoritative', async () => {
    const stored = row({
      address: 'Kleine Burg 15', city: 'Braunschweig', postal_code: '38100',
      latitude: '52.2647', longitude: '10.5236',
      image_url: 'https://example.com/one.jpg', image_urls: ['https://example.com/one.jpg', 'https://example.com/two.jpg'],
      facilities: ['Wi-Fi'], house_rules: ['No smoking'], contact_email: 'hello@example.com'
    });
    poolQuery.mockResolvedValue({ rowCount: 1, rows: [stored] });

    const created = await createLocation({
      title: 'Braunschweig', address: ' Kleine Burg 15 ', city: ' Braunschweig ', postalCode: ' 38100 ',
      latitude: 52.2647, longitude: 10.5236, imageUrl: 'https://legacy.example/image.jpg',
      imageUrls: [' https://example.com/one.jpg ', 'https://example.com/one.jpg', 'https://example.com/two.jpg'],
      facilities: [' Wi-Fi ', '', 'Wi-Fi'], houseRules: [' No smoking '], contactEmail: ' hello@example.com '
    });

    expect(created).toMatchObject({ latitude: 52.2647, longitude: 10.5236, imageUrls: stored.image_urls });
    expect(poolQuery.mock.calls[0][1][8]).toBe('https://example.com/one.jpg');
    expect(poolQuery.mock.calls[0][1][9]).toEqual(['https://example.com/one.jpg', 'https://example.com/two.jpg']);
    expect(poolQuery.mock.calls[0][1][13]).toEqual(['Wi-Fi']);
  });

  it('preserves omitted update fields while clearing explicit nullable and array values', async () => {
    const existing = row({
      description: 'Keep me', address: 'Old street', city: 'Berlin', image_url: 'https://example.com/old.jpg',
      image_urls: ['https://example.com/old.jpg'], facilities: ['Wi-Fi']
    });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [existing] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [row({ ...existing, address: null, image_url: null, image_urls: [], facilities: [] })] });

    const updated = await updateLocation(targetId, { address: null, imageUrls: [], facilities: [] });

    expect(updated).toMatchObject({ description: 'Keep me', city: 'Berlin', address: null, imageUrls: [], facilities: [] });
    const [, values] = poolQuery.mock.calls[1];
    expect(values[1]).toBe('Keep me');
    expect(values[2]).toBeNull();
    expect(values[9]).toEqual([]);
    expect(values[13]).toEqual([]);
  });

  it('turns product city and region IDs into typed Regiondo mapping candidates', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT regiondo_raw')) {
        return {
          rowCount: 1,
          rows: [{
            regiondo_raw: {
              city: 'Braunschweig',
              city_id: '5467',
              location_address: 'Kleine Burg 15, Braunschweig, Deutschland',
              location_name: 'VirtuaLounge',
              region_id: 40843
            }
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(listRegiondoLocationCandidates()).resolves.toEqual([
      {
        addresses: ['Kleine Burg 15, Braunschweig, Deutschland'],
        id: '5467',
        locationNames: ['VirtuaLounge'],
        locationType: 'city',
        title: 'Braunschweig'
      },
      {
        addresses: ['Kleine Burg 15, Braunschweig, Deutschland'],
        id: '40843',
        locationNames: ['VirtuaLounge'],
        locationType: 'region',
        title: 'VirtuaLounge'
      }
    ]);
  });
});
