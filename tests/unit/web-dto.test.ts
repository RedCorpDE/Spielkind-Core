import { describe, expect, it } from 'vitest';
import { safeWebProduct } from '../../src/http/routes/web.routes.js';

describe('safe web DTOs', () => {
  it('omits provider and VAT internals from public product responses', () => {
    const dto = safeWebProduct({
      id: 'product-1', title: 'Session', description: 'Play', imageUrl: null,
      bookingProvider: 'regiondo', price: { amount: 2500, currency: 'EUR' },
      vatBasisPoints: 1900, variants: []
    });
    expect(dto).toEqual({
      id: 'product-1', title: 'Session', description: 'Play', imageUrl: null,
      price: { amount: 2500, currency: 'EUR' }, variants: []
    });
    expect(dto).not.toHaveProperty('bookingProvider');
    expect(dto).not.toHaveProperty('vatBasisPoints');
  });
});
