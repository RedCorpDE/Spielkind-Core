import { describe, expect, it } from 'vitest';
import {
  extractRegiondoAvailabilitySlots,
  extractRegiondoVariations,
  normalizeRegiondoCatalogVariation
} from '../../src/modules/regiondo/regiondo-catalog-normalizer.js';
import { fetchRegiondoCatalogProducts } from '../../src/modules/regiondo/regiondo-catalog-sync.service.js';
import { RegiondoCatalogSyncError } from '../../src/modules/regiondo/regiondo-catalog.errors.js';
import { planRegiondoCatalogCleanupForTest } from '../../src/modules/regiondo/regiondo-catalog.repository.js';
import { RegiondoClient } from '../../src/modules/regiondo/regiondo.client.js';

const observedCatalogProduct = {
  base_price: '15.00',
  default_name: 'League of Legends Finals',
  image: 'https://cdn.example.com/product.jpg',
  name: 'League of Legends Finals: Public Viewing Tagesticket',
  original_price: '18.00',
  product_id: '297021',
  short_description: '<p>Public viewing ticket</p>'
};

describe('RegiondoClient.getCatalogProducts', () => {
  it('aggregates all catalog pages through Regiondo offset pagination', async () => {
    const requestedUrls: URL[] = [];
    const firstPageProducts = [
      {
        ...observedCatalogProduct,
        product_id: 'product-1'
      },
      {
        ...observedCatalogProduct,
        product_id: 'product-2'
      }
    ];
    const secondPageProducts = [
      {
        ...observedCatalogProduct,
        product_id: 'product-3'
      }
    ];
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      catalogPageSize: 2,
      currency: 'EUR',
      fetchImplementation: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        requestedUrls.push(url);

        const offset = url.searchParams.get('offset');
        const isSecondPage = offset === '2';
        const body = isSecondPage
          ? {
              data: secondPageProducts,
              page: {
                current: 2,
                last: 2,
                next: 2,
                total_items: 3,
                total_pages: 2,
                limit: 2
              }
            }
          : {
              data: firstPageProducts,
              page: {
                current: 1,
                last: 2,
                next: 2,
                total_items: 3,
                total_pages: 2,
                limit: 2
              }
            };

        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status: 200
        });
      },
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    const products = await client.getCatalogProducts();

    expect(products.map((product) => product.product_id)).toEqual(['product-1', 'product-2', 'product-3']);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]?.searchParams.get('currency')).toBe('EUR');
    expect(requestedUrls[0]?.searchParams.get('limit')).toBe('2');
    expect(requestedUrls[0]?.searchParams.get('offset')).toBeNull();
    expect(requestedUrls[0]?.searchParams.get('store_locale')).toBe('de-DE');
    expect(requestedUrls[1]?.searchParams.get('offset')).toBe('2');
  });

  it('fails fast when the catalog payload does not match the expected product shape', async () => {
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async () =>
        new Response(JSON.stringify({ data: [{ id: 'legacy-product-1' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        }),
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    await expect(client.getCatalogProducts()).rejects.toBeInstanceOf(RegiondoCatalogSyncError);
    await expect(client.getCatalogProducts()).rejects.toMatchObject({
      message: 'Regiondo catalog payload did not match the expected product shape.',
      statusCode: 502
    });
  });
});

describe('Regiondo catalog normalizers', () => {
  it('extracts variations across alias keys', () => {
    const variations = extractRegiondoVariations({
      product: {
        product_variations: [{ variation_id: '720707' }],
        variants: [{ variation_id: '720708' }]
      }
    });

    expect(variations.map((variation) => variation.variation_id)).toEqual(['720707', '720708']);
  });

  it('extracts unique availability slots from nested payloads', () => {
    const slots = extractRegiondoAvailabilitySlots(
      {
        data: [
          {
            date: '2026-05-10T00:00:00Z',
            times: ['18:00', '19:30', '18:00']
          }
        ]
      },
      20
    );

    expect(slots).toEqual([
      { date: '2026-05-10', time: '18:00' },
      { date: '2026-05-10', time: '19:30' }
    ]);
  });

  it('normalizes variation metadata from detail payloads', () => {
    const variation = normalizeRegiondoCatalogVariation(
      {
        appointment_type: 'appointment',
        date_from: '2026-05-10T18:00:00Z',
        date_to: '2026-05-11',
        original_price: '25.50',
        title: 'Evening slot',
        variation_id: '720707'
      },
      '297021',
      {}
    );

    expect(variation).toMatchObject({
      appointmentType: 'appointment',
      dateFrom: '2026-05-10',
      dateTo: '2026-05-11',
      price: 25.5,
      regiondoProductId: '297021',
      regiondoVariantId: '720707',
      title: 'Evening slot'
    });
  });
});

describe('fetchRegiondoCatalogProducts', () => {
  it('hydrates detail, availability, and per-variation options from Regiondo', async () => {
    const requestedAvailableOptions: Array<{ date?: string; time?: string; variationId: string }> = [];

    const result = await fetchRegiondoCatalogProducts({
      availabilityRangeDays: 30,
      client: {
        getAvailableOptions: async (input: { date?: string; time?: string; variationId: string }) => {
          requestedAvailableOptions.push(input);

          if (input.date && input.time) {
            return {
              items: [{ option_id: '2017401', values: ['VIP', 'Balcony'] }]
            };
          }

          return {
            data: [{ option_id: '2017401', title: 'Seat', values: ['VIP'] }]
          };
        },
        getCatalogProducts: async () => [
          {
            ...observedCatalogProduct,
            product_id: '297021'
          }
        ],
        getProductDetail: async () => ({
          product_variations: [
            {
              appointmentType: 'timeslot',
              dateFrom: '2026-05-10',
              options: [{ option_id: '2017401', title: 'Static Seat', values: ['Static'] }],
              title: 'Morning slot',
              variation_id: '720707'
            },
            {
              options: [{ option_id: '2017401', values: ['General'] }],
              title: 'Evening slot',
              variation_id: '720708'
            }
          ],
          short_description: '<p>Detailed product</p>'
        }),
        getVariationAvailability: async () => ({
          data: [
            {
              date: '2026-05-10',
              times: ['18:00', '18:00']
            }
          ]
        })
      } as unknown as RegiondoClient,
      maxOptionSlotsPerVariation: 5,
      productDetailConcurrency: 1,
      variationSyncConcurrency: 1
    });

    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      description: '<p>Detailed product</p>',
      regiondoProductId: '297021',
      title: 'League of Legends Finals: Public Viewing Tagesticket'
    });
    expect(result.products[0]?.variations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appointmentType: 'timeslot',
          regiondoVariantId: '720707',
          title: 'Morning slot'
        }),
        expect.objectContaining({
          regiondoVariantId: '720708',
          title: 'Evening slot'
        })
      ])
    );
    expect(result.products[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          regiondoOptionId: '2017401',
          regiondoVariantId: '720707',
          valuesJson: ['VIP', 'Balcony']
        }),
        expect.objectContaining({
          regiondoOptionId: '2017401',
          regiondoVariantId: '720708'
        })
      ])
    );
    expect(result.products[0]?.options).toHaveLength(2);
    expect(
      result.products[0]?.options.every((option) => Boolean(option.raw._sync_context))
    ).toBe(true);
    expect(requestedAvailableOptions).toEqual([
      { variationId: '720707' },
      { date: '2026-05-10', time: '18:00', variationId: '720707' },
      { variationId: '720708' },
      { date: '2026-05-10', time: '18:00', variationId: '720708' }
    ]);
  });
});

describe('planRegiondoCatalogCleanupForTest', () => {
  it('separates deletable malformed rows from rows that are still referenced by bookings', () => {
    const cleanupPlan = planRegiondoCatalogCleanupForTest([
      {
        bookingCount: 0,
        productId: 'deletable-product-id',
        regiondoProductId: 'undefined'
      },
      {
        bookingCount: 2,
        productId: 'blocked-product-id',
        regiondoProductId: ''
      }
    ]);

    expect(cleanupPlan.deletableProductIds).toEqual(['deletable-product-id']);
    expect(cleanupPlan.blockedRows).toEqual([
      {
        bookingCount: 2,
        productId: 'blocked-product-id',
        regiondoProductId: ''
      }
    ]);
  });
});
