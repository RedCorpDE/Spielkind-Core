import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQuery, transactionQuery } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transactionQuery: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: poolQuery }
}));
vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: (callback: (client: { query: typeof transactionQuery }) => unknown) => callback({ query: transactionQuery })
}));

const {
  addProductOffering,
  createAdminProduct,
  createProductVariant,
  deleteProductVariant,
  updateProductOffering
} = await import('../../src/modules/products/product-admin.repository.js');

const productRow = {
  product_id: '11111111-1111-1111-1111-111111111111',
  title: 'Escape Room',
  description: 'A native product',
  image_url: 'https://example.com/product.jpg',
  base_amount: '20.00',
  booking_provider: 'core',
  price_minor: '2000',
  currency: 'EUR',
  vat_basis_points: 1900,
  regiondo_product_id: null,
  regiondo_raw: null,
  resources: [],
  locations: []
};

describe('Core-native product creation repository', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    transactionQuery.mockReset();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ product_id: productRow.product_id }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [productRow] });
  });

  it('stores authoritative minor units and forces Core provider fields', async () => {
    const product = await createAdminProduct({
      title: '  Escape Room  ',
      description: '  A native product  ',
      imageUrl: '  https://example.com/product.jpg  ',
      baseAmount: 2000,
      currency: 'eur',
      vatBasisPoints: 1900
    });

    expect(product).toMatchObject({
      bookingProvider: 'core',
      priceMinor: 2000,
      regiondoProductId: null,
      vatBasisPoints: 1900
    });
    expect(poolQuery.mock.calls[0][0]).toContain("'core', $4");
    expect(poolQuery.mock.calls[0][0]).toContain('NULL, NULL');
    expect(poolQuery.mock.calls[0][1]).toEqual([
      'Escape Room',
      'A native product',
      'https://example.com/product.jpg',
      2000,
      'EUR',
      1900
    ]);
  });

  it('uses the existing uniqueness rule when creating a Product Offering', async () => {
    poolQuery.mockReset();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ product_id: productRow.product_id }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [productRow] });

    await expect(addProductOffering(
      '22222222-2222-2222-2222-222222222222',
      productRow.product_id
    )).resolves.toMatchObject({ productId: productRow.product_id });

    expect(poolQuery.mock.calls[0][0]).toContain('ON CONFLICT (location_id, product_id)');
    expect(poolQuery.mock.calls[0][0]).toContain('DO UPDATE SET enabled = true');
  });

  it('creates a native Variant with nullable provider ids and minor-unit pricing', async () => {
    poolQuery.mockReset();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ booking_provider: 'core' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          variant_id: '22222222-2222-2222-2222-222222222222',
          title: '8 Hours', price_minor: '3500', currency: 'EUR'
        }]
      });

    await expect(createProductVariant(productRow.product_id, {
      title: '8 Hours', priceMinor: 3500, currency: 'EUR'
    })).resolves.toMatchObject({ title: '8 Hours', priceMinor: 3500, providerManaged: false });

    expect(poolQuery.mock.calls[1][0]).toContain('regiondo_variant_id, regiondo_product_id, regiondo_raw');
    expect(poolQuery.mock.calls[1][0]).toContain('NULL, NULL, NULL');
    expect(poolQuery.mock.calls[1][1]).toEqual([productRow.product_id, '8 Hours', 3500, 'EUR']);
  });

  it('surfaces FK-protected Variant deletion as in-use instead of cascading history', async () => {
    poolQuery.mockReset();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ booking_provider: 'core' }] })
      .mockRejectedValueOnce(Object.assign(new Error('foreign key violation'), { code: '23503' }));

    await expect(deleteProductVariant(
      productRow.product_id,
      '22222222-2222-2222-2222-222222222222'
    )).resolves.toBe('in_use');
  });

  it('switches one offering to Core without rewriting historical booking providers', async () => {
    poolQuery.mockReset();
    transactionQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          product_offering_id: '33333333-3333-3333-3333-333333333333',
          booking_provider: 'regiondo'
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ variants: 1, resources: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [productRow] });

    await expect(updateProductOffering(
      '22222222-2222-2222-2222-222222222222',
      productRow.product_id,
      { bookingProvider: 'core' }
    )).resolves.toMatchObject({ productId: productRow.product_id });

    const statements = transactionQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('UPDATE location_products'))).toBe(true);
    expect(statements.every((sql) => !/UPDATE\s+bookings\b/i.test(sql))).toBe(true);
  });

  it('rejects a Regiondo offering without an external mapping', async () => {
    transactionQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          product_offering_id: '33333333-3333-3333-3333-333333333333',
          booking_provider: 'core'
        }]
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(updateProductOffering(
      '22222222-2222-2222-2222-222222222222',
      productRow.product_id,
      { bookingProvider: 'regiondo' }
    )).rejects.toThrow('A Regiondo product mapping is required');
  });
});
