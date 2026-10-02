import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../src/client-api/types.js';
import { resolveWebCheckoutIdentity } from '../../src/modules/web/web-checkout-identity.js';
import { webCheckoutRequestHash, type WebCheckoutInput } from '../../src/modules/web/web-checkout.service.js';

const authenticatedClient: ClientProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Client',
  lastName: 'A',
  displayName: 'Client A',
  email: 'client-a@example.com',
  phone: '+4912345',
  emailVerified: true,
  onboardingCompleted: true,
  avatarUrl: null
};

describe('web checkout identity', () => {
  it('uses the authenticated Core client and ignores spoofed guest identity', () => {
    expect(resolveWebCheckoutIdentity(authenticatedClient, {
      firstName: 'Client', lastName: 'B', email: 'client-b@example.com'
    })).toEqual({
      kind: 'authenticated',
      clientId: authenticatedClient.id,
      contact: {
        firstName: 'Client', lastName: 'A', email: 'client-a@example.com', phone: '+4912345'
      }
    });
  });

  it('accepts and normalizes valid guest details without authentication', () => {
    expect(resolveWebCheckoutIdentity(null, {
      firstName: ' Guest ', lastName: ' User ', email: 'GUEST@EXAMPLE.COM', phone: ''
    })).toEqual({
      kind: 'guest',
      contact: { firstName: 'Guest', lastName: 'User', email: 'guest@example.com', phone: '' }
    });
  });

  it('rejects missing guest details without authentication', () => {
    expect(() => resolveWebCheckoutIdentity(null, { email: 'guest@example.com' }))
      .toThrow('Guest details must include first name, last name, and a valid email address.');
  });

  it('binds idempotency to the authenticated client identity', () => {
    const base: Omit<WebCheckoutInput, 'identity'> = {
      locationId: 'location', productId: 'product', quantity: 1,
      availability: {
        locationId: 'location', productId: 'product', variantId: null,
        startsAt: '2026-10-01T10:00:00.000Z', endsAt: '2026-10-01T11:00:00.000Z',
        expiresAt: '2026-10-01T09:30:00.000Z'
      },
      idempotencyKey: 'same-browser-key'
    };
    const first = webCheckoutRequestHash({
      ...base,
      identity: resolveWebCheckoutIdentity(authenticatedClient, null)
    });
    const second = webCheckoutRequestHash({
      ...base,
      identity: resolveWebCheckoutIdentity({ ...authenticatedClient, id: '22222222-2222-4222-8222-222222222222' }, null)
    });
    expect(first).not.toBe(second);
  });
});
