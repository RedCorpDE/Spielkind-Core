import { describe, expect, it } from 'vitest';
import { hashWebToken } from '../../src/modules/web/web-token.service.js';

describe('web token storage', () => {
  it('stores deterministic hashes rather than raw opaque tokens', () => {
    const raw = 'sensitive-checkout-token';
    const hash = hashWebToken(raw);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(raw);
  });
});
