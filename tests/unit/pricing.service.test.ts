import { describe, expect, it } from 'vitest';
import { calculatePrice, quoteWithClient } from '../../src/modules/pricing/pricing.service.js';

describe('pricing service', () => {
  it('calculates option deltas, quantity, VAT, and percentage discounts in minor units', () => {
    const quote = calculatePrice({
      productId: 'product', productName: 'LAN seat', baseGross: 3900,
      vatBasisPoints: 1900, currency: 'EUR', quantity: 2,
      options: [{ optionId: 'option', name: 'Monitor', value: '27 inch', priceDelta: 500 }],
      discount: { type: 'percentage', percentageBasisPoints: 1000 }
    });
    expect(quote.subtotalGross).toBe(8800);
    expect(quote.discount).toBe(880);
    expect(quote.total).toBe(7920);
    expect(quote.subtotalNet + quote.tax).toBe(quote.total);
  });

  it('keeps a completed quote snapshot independent from later catalog prices', () => {
    const purchased = calculatePrice({
      productId: 'product', productName: 'Product', baseGross: 3900,
      vatBasisPoints: 1900, currency: 'EUR', quantity: 1
    });
    calculatePrice({
      productId: 'product', productName: 'Product', baseGross: 4500,
      vatBasisPoints: 1900, currency: 'EUR', quantity: 1
    });
    expect(purchased.items[0].unitPriceGross).toBe(3900);
    expect(purchased.total).toBe(3900);
  });

  it('quotes a Core-authored Variant and Option while filtering by active catalog ownership', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (queries.length === 1) {
          return {
            rowCount: 1,
            rows: [{
              product_id: 'product', title: 'LAN Session', booking_provider: 'core', price_minor: 2000,
              currency: 'EUR', vat_basis_points: 1900, variant_id: 'variant', variant_title: '8 Hours',
              variant_price_minor: 3500
            }]
          };
        }
        return {
          rowCount: 1,
          rows: [{ option_id: 'option', title: 'Headset Rental', price_delta_minor: 300 }]
        };
      }
    };

    const quote = await quoteWithClient(client as never, {
      productId: 'product', variantId: 'variant', quantity: 2,
      options: [{ optionId: 'option', value: 'Included' }]
    });

    expect(quote.total).toBe(7600);
    expect(quote.items[0]).toMatchObject({
      variantName: '8 Hours', unitPriceGross: 3800,
      options: [{ name: 'Headset Rental', value: 'Included', priceDelta: 300 }]
    });
    expect(queries[0]).toContain("product.booking_provider = 'core' AND variant.regiondo_variant_id IS NULL");
    expect(queries[1]).toContain("product.booking_provider = 'core' AND option_record.regiondo_option_id IS NULL");
  });

  it('resolves the internal default Variant when variantId is omitted', async () => {
    const queryParameters: unknown[][] = [];
    const client = {
      query: async (_sql: string, parameters: unknown[]) => {
        queryParameters.push(parameters);
        if (queryParameters.length === 1) {
          return {
            rowCount: 1,
            rows: [{
              product_id: 'product', title: 'Birthday Package', booking_provider: 'core', price_minor: 10000,
              currency: 'EUR', vat_basis_points: 1900, variant_id: 'default-variant', variant_title: null,
              variant_price_minor: 10000
            }]
          };
        }
        return { rowCount: 1, rows: [{ option_id: 'cake', title: 'Cake', price_delta_minor: 1500 }] };
      }
    };

    const quote = await quoteWithClient(client as never, {
      productId: 'product', quantity: 1, options: [{ optionId: 'cake', value: 'Chocolate' }]
    });

    expect(quote.items[0]).toMatchObject({ variantId: 'default-variant', variantName: null, unitPriceGross: 11500 });
    expect(queryParameters[1]?.[2]).toBe('default-variant');
  });
});

