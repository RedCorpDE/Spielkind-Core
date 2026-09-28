import { describe, expect, it } from 'vitest';
import { requireWebServiceScope } from '../../src/http/web-auth.js';

function request(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as never;
}

describe('WordPress service authentication', () => {
  it('accepts the configured token for an explicitly granted scope', async () => {
    await expect(requireWebServiceScope(
      request('0123456789abcdef0123456789abcdef'),
      'locations:read'
    )).resolves.toBeUndefined();
  });

  it('rejects an invalid token without echoing it', async () => {
    await expect(requireWebServiceScope(request('not-the-configured-token'), 'checkout:create'))
      .rejects.toMatchObject({ statusCode: 401, code: 'AUTH_INVALID' });
  });

  it('rejects a valid service identity when the route scope is missing', async () => {
    const scopedRequest = request('0123456789abcdef0123456789abcdef') as unknown as { webServiceScopes: Set<string> };
    scopedRequest.webServiceScopes = new Set(['locations:read']);
    await expect(requireWebServiceScope(scopedRequest as never, 'checkout:create'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_INSUFFICIENT_SCOPE' });
  });
});

