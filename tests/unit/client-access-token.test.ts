import { describe, expect, it } from 'vitest';
import {
  ClientAccessTokenError,
  createClientAccessToken,
  verifyClientAccessToken
} from '../../src/client-api/tokens.js';

describe('client access tokens', () => {
  it('round-trips the customer and session identifiers', () => {
    const created = createClientAccessToken('client-1', 'session-1');
    const payload = verifyClientAccessToken(created.token);

    expect(payload).toMatchObject({ type: 'client_access', sub: 'client-1', sid: 'session-1' });
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a modified signature', () => {
    const created = createClientAccessToken('client-1', 'session-1');
    const tampered = `${created.token.slice(0, -1)}${created.token.endsWith('a') ? 'b' : 'a'}`;

    expect(() => verifyClientAccessToken(tampered)).toThrow(ClientAccessTokenError);
  });
});
