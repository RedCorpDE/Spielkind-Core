import { describe, expect, it } from 'vitest';
import { createAvailabilityToken, verifyAvailabilityToken } from '../../src/modules/web/availability-token.js';

describe('web availability tokens', () => {
  const payload = {
    locationId: 'af79d0f6-cb17-4f98-8a72-cf4fa217fc7f',
    productId: '431d4598-cf62-4ff4-bf84-40eb10693bf0',
    variantId: null,
    startsAt: '2030-09-28T10:00:00.000Z',
    endsAt: '2030-09-28T12:00:00.000Z',
    expiresAt: '2030-09-28T09:55:00.000Z'
  };

  it('round-trips signed customer-safe slot data', () => {
    expect(verifyAvailabilityToken(createAvailabilityToken(payload))).toEqual(payload);
  });

  it('rejects tampering', () => {
    const token = createAvailabilityToken(payload);
    expect(verifyAvailabilityToken(`${token.slice(0, -1)}x`)).toBeNull();
  });
});

