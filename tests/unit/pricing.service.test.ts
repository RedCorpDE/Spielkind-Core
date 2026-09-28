import { describe, expect, it } from 'vitest';
import { calculatePrice } from '../../src/modules/pricing/pricing.service.js';

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
});

