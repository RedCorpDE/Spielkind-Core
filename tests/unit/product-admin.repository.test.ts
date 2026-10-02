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
  cloneAdminProduct,
  createAdminProduct,
  createProductVariant,
  deleteAdminProduct,
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
      1900,
      null
    ]);
  });

  it('clones catalog, offerings, resources and availability as an independent Core product', async () => {
    const clonedProductId = '44444444-4444-4444-4444-444444444444';
    const sourceVariantId = '55555555-5555-5555-5555-555555555555';
    const clonedVariantId = '66666666-6666-6666-6666-666666666666';
    const sourceOfferingId = '77777777-7777-7777-7777-777777777777';
    const clonedOfferingId = '88888888-8888-8888-8888-888888888888';
    transactionQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          title: productRow.title,
          description: productRow.description,
          image_url: productRow.image_url,
          base_amount: productRow.base_amount,
          price_minor: productRow.price_minor,
          currency: productRow.currency,
          vat_basis_points: productRow.vat_basis_points,
          cancellation_policy_id: null
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ product_id: clonedProductId }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          variant_id: sourceVariantId,
          title: '4 Hours',
          price: '20.00',
          price_minor: '2000',
          currency: 'EUR',
          duration_minutes: 240,
          cancellation_policy_id: null,
          is_active: true,
          schedule_rule_enabled: true,
          allowed_weekdays: [1, 2, 3, 4, 5],
          local_start_time: '10:00',
          local_end_time: '20:00'
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ variant_id: clonedVariantId }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ option_count: '0' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          product_offering_id: sourceOfferingId,
          location_id: '22222222-2222-2222-2222-222222222222',
          enabled: true,
          time_selection_mode: 'start_duration',
          timezone: 'Europe/Berlin',
          fixed_start_time: null,
          fixed_end_time: null,
          earliest_start_time: '10:00',
          latest_start_time: '20:00',
          start_interval_minutes: 30,
          min_participants: 1,
          max_participants: 8,
          min_duration_minutes: 60,
          max_duration_minutes: 240,
          duration_step_minutes: 30,
          default_duration_minutes: 120,
          allowed_duration_minutes: [60, 120, 240],
          min_advance_minutes: 60,
          max_advance_days: 90,
          same_day_booking_allowed: true,
          pricing_mode: 'per_quantity',
          date_range_billing_unit: 'nights'
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ product_offering_id: clonedOfferingId }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          location_id: '22222222-2222-2222-2222-222222222222',
          product_variant_id: sourceVariantId,
          resource_id: null,
          rule_type: 'recurring',
          starts_at: null,
          ends_at: null,
          weekdays: [1, 2, 3, 4, 5],
          local_start_time: '10:00',
          local_end_time: '20:00',
          timezone: 'Europe/Berlin',
          capacity_override: null,
          is_active: true,
          metadata: {}
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    poolQuery.mockReset().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...productRow, product_id: clonedProductId, title: 'Escape Room (Copy)' }]
    });

    await expect(cloneAdminProduct(productRow.product_id)).resolves.toMatchObject({
      productId: clonedProductId,
      title: 'Escape Room (Copy)',
      bookingProvider: 'core'
    });

    const statements = transactionQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("'core'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO product_options'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO location_products'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO product_offering_resources'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO availability_rules'))).toBe(true);
    expect(transactionQuery.mock.calls.at(-1)?.[1]?.[2]).toBe(clonedVariantId);
  });

  it('protects products referenced by booking history from deletion', async () => {
    poolQuery.mockReset().mockRejectedValueOnce(
      Object.assign(new Error('foreign key violation'), { code: '23503' })
    );

    await expect(deleteAdminProduct(productRow.product_id)).resolves.toBe('in_use');
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
    expect(poolQuery.mock.calls[1][1]).toEqual([
      productRow.product_id, '8 Hours', 3500, 'EUR', null,
      true, false, null, null, null, null
    ]);
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
