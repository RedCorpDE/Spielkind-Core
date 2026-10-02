import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: poolQuery }
}));

const { getCatalogProductOffering, listCatalogProducts } =
  await import('../../src/modules/catalog/catalog.repository.js');

const locationId = '11111111-1111-4111-8111-111111111111';

describe('customer catalog product listing', () => {
  beforeEach(() => poolQuery.mockReset());

  it('filters location listings through enabled Product Offerings', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(listCatalogProducts(locationId)).resolves.toEqual([]);

    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INNER JOIN location_products offering'),
      [locationId]
    );
    const query = poolQuery.mock.calls[0][0] as string;
    expect(query).toContain('offering.product_id = product.product_id');
    expect(query).toContain('offering.location_id = $1');
    expect(query).toContain('offering.enabled = true');
  });

  it('returns both Core-native and Regiondo-backed products in one normalized shape', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        {
          product_id: '22222222-2222-4222-8222-222222222222',
          title: 'LAN Room',
          description: 'Core product',
          image_url: null,
          booking_provider: 'core',
          price_minor: '14900',
          currency: 'EUR',
          vat_basis_points: 1900,
          variants: []
        },
        {
          product_id: '33333333-3333-4333-8333-333333333333',
          title: 'VR Area',
          description: null,
          image_url: 'https://example.com/vr.jpg',
          booking_provider: 'regiondo',
          price_minor: 3900,
          currency: 'EUR',
          vat_basis_points: 1900,
          variants: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              title: 'One hour',
              price: { amount: 3900, currency: 'EUR' }
            }
          ]
        }
      ]
    });

    const products = await listCatalogProducts(locationId);

    expect(products).toEqual([
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'LAN Room',
        description: 'Core product',
        imageUrl: null,
        bookingProvider: 'core',
        price: { amount: 14900, currency: 'EUR' },
        vatBasisPoints: 1900,
        variants: []
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'VR Area',
        description: null,
        imageUrl: 'https://example.com/vr.jpg',
        bookingProvider: 'regiondo',
        price: { amount: 3900, currency: 'EUR' },
        vatBasisPoints: 1900,
        variants: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            title: 'One hour',
            price: { amount: 3900, currency: 'EUR' }
          }
        ]
      }
    ]);

    const query = poolQuery.mock.calls[0][0] as string;
    expect(query).toContain("offering.booking_provider = 'regiondo'");
    expect(query).toContain("offering.booking_provider = 'core'");
  });

  it('returns a venue-scoped offering with normalized booking fields, variants, and options', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        product_id: '22222222-2222-4222-8222-222222222222',
        title: 'LAN Room',
        description: 'Private room',
        image_url: null,
        booking_provider: 'core',
        offering_booking_provider: 'core',
        price_minor: '14900',
        currency: 'EUR',
        vat_basis_points: 1900,
        product_offering_id: '55555555-5555-4555-8555-555555555555',
        location_id: locationId,
        location_name: 'Braunschweig',
        enabled: true,
        variants: [{
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Four hours',
          price: { amount: 14900, currency: 'EUR' }
        }],
        options: [{
          id: '44444444-4444-4444-8444-444444444444',
          variantId: '33333333-3333-4333-8333-333333333333',
          title: 'Setup',
          values: ['Standard', { id: 'streaming', label: 'Streaming ready' }],
          priceDelta: { amount: 1500, currency: 'EUR' }
        }]
      }]
    });

    const product = await getCatalogProductOffering(
      '22222222-2222-4222-8222-222222222222',
      locationId
    );

    expect(product).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      offering: {
        id: '55555555-5555-4555-8555-555555555555',
        locationId,
        locationName: 'Braunschweig',
        active: true
      },
      bookingConfiguration: {
        mode: 'normalized',
        timeSelection: { mode: 'start_end', timezone: 'Europe/Berlin' },
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'startAt', type: 'datetime' }),
          expect.objectContaining({ key: 'participants', type: 'quantity', min: 1, max: 100 }),
          expect.objectContaining({ key: 'variantId', type: 'variant' }),
          expect.objectContaining({
            key: 'option:44444444-4444-4444-8444-444444444444',
            type: 'option',
            values: [
              { value: 'Standard', label: 'Standard' },
              { value: 'streaming', label: 'Streaming ready' }
            ]
          })
        ])
      }
    });
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('offering.enabled = true'), [
      '22222222-2222-4222-8222-222222222222',
      locationId
    ]);
    const query = poolQuery.mock.calls[0][0] as string;
    expect(query).toContain('location.title AS location_name');
    expect(query).not.toContain('location.name AS location_name');
  });

  it('normalizes a PostgreSQL date object to a YYYY-MM-DD fixed booking date', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        product_id: '22222222-2222-4222-8222-222222222222',
        title: 'Akiba Night',
        description: null,
        image_url: null,
        booking_provider: 'core',
        offering_booking_provider: 'core',
        price_minor: '1350',
        currency: 'EUR',
        vat_basis_points: 1900,
        product_offering_id: '55555555-5555-4555-8555-555555555555',
        location_id: locationId,
        location_name: 'Braunschweig',
        enabled: true,
        variants: [],
        options: [],
        time_selection_mode: 'fixed_duration',
        timezone: 'Europe/Berlin',
        date_selection: 'fixed',
        fixed_date: new Date(2026, 9, 31),
        fixed_start_time: '19:00:00',
        default_duration_minutes: 480
      }]
    });

    const product = await getCatalogProductOffering(
      '22222222-2222-4222-8222-222222222222',
      locationId
    );

    expect(product?.bookingConfiguration.timeSelection).toMatchObject({
      dateSelection: 'fixed',
      fixedDate: '2026-10-31',
      fixedStartTime: '19:00'
    });
  });

  it('does not return products that have no enabled offering for the venue', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(getCatalogProductOffering(
      '22222222-2222-4222-8222-222222222222',
      locationId
    )).resolves.toBeNull();
  });
});
