import { describe, expect, it } from 'vitest';
import { RegiondoCatalogSyncError } from '../../src/modules/regiondo/regiondo-catalog.errors.js';
import {
  mapRegiondoCatalogProductForTest,
  planRegiondoCatalogCleanupForTest
} from '../../src/modules/regiondo/regiondo-catalog.repository.js';
import { RegiondoClient } from '../../src/modules/regiondo/regiondo.client.js';
import { regiondoCatalogProductsSchema } from '../../src/modules/regiondo/regiondo.types.js';

const observedCatalogProduct = {
  base_price: '15.00',
  default_name: 'League of Legends Finals',
  image: 'https://cdn.example.com/product.jpg',
  name: 'League of Legends Finals: Public Viewing Tagesticket',
  original_price: '18.00',
  product_id: '297021',
  short_description: '<p>Public viewing ticket</p>',
  variations: [
    {
      options: [{ option_id: '2017401' }, { option_id: '2017402', title: 'VIP', values: ['vip'] }],
      variation_id: '720707'
    }
  ]
};

describe('regiondoCatalogProductsSchema', () => {
  it('accepts the observed Regiondo catalog payload shape', () => {
    const [parsed] = regiondoCatalogProductsSchema.parse([observedCatalogProduct]);

    expect(parsed.product_id).toBe('297021');
    expect(parsed.name).toBe('League of Legends Finals: Public Viewing Tagesticket');
    expect(parsed.base_price).toBe(15);
    expect(parsed.variations?.[0]?.variation_id).toBe('720707');
    expect(parsed.variations?.[0]?.options?.[0]?.option_id).toBe('2017401');
  });

  it('rejects the old id-only product shape', () => {
    expect(() => regiondoCatalogProductsSchema.parse([{ id: 'legacy-product-1' }])).toThrow();
  });
});

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
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    const products = await client.getCatalogProducts();

    expect(products.map((product) => product.product_id)).toEqual(['product-1', 'product-2', 'product-3']);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]?.searchParams.get('limit')).toBe('2');
    expect(requestedUrls[0]?.searchParams.get('offset')).toBeNull();
    expect(requestedUrls[1]?.searchParams.get('limit')).toBe('2');
    expect(requestedUrls[1]?.searchParams.get('offset')).toBe('2');
  });

  it('fails fast when the catalog payload does not match the expected product shape', async () => {
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      fetchImplementation: async () =>
        new Response(JSON.stringify({ data: [{ id: 'legacy-product-1' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        }),
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
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

describe('mapRegiondoCatalogProductForTest', () => {
  it('maps observed product fields and flattens deduplicated variation options', () => {
    const [parsedProduct] = regiondoCatalogProductsSchema.parse([
      {
        ...observedCatalogProduct,
        thumbnail: 'https://cdn.example.com/thumb.jpg',
        variations: [
          {
            options: [{ option_id: '2017401' }, { option_id: '2017402', title: 'VIP', values: ['vip'] }],
            variation_id: '720707'
          },
          {
            options: [{ option_id: '2017401', title: 'Standard' }],
            original_price: 25,
            title: 'Evening slot',
            variation_id: '720708'
          }
        ]
      }
    ]);

    const mapped = mapRegiondoCatalogProductForTest(parsedProduct);

    expect(mapped.regiondoProductId).toBe('297021');
    expect(mapped.title).toBe('League of Legends Finals: Public Viewing Tagesticket');
    expect(mapped.description).toBe('<p>Public viewing ticket</p>');
    expect(mapped.imageUrl).toBe('https://cdn.example.com/product.jpg');
    expect(mapped.baseAmount).toBe(15);
    expect(mapped.variations).toEqual([
      expect.objectContaining({ price: 0, regiondoVariantId: '720707', title: null }),
      expect.objectContaining({ price: 25, regiondoVariantId: '720708', title: 'Evening slot' })
    ]);
    expect(mapped.options).toHaveLength(2);
    expect(mapped.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regiondoOptionId: '2017401', title: 'Standard', valuesJson: null }),
        expect.objectContaining({ regiondoOptionId: '2017402', title: 'VIP', valuesJson: ['vip'] })
      ])
    );
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
