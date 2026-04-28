import assert from 'node:assert/strict';
import test from 'node:test';
import { RegiondoClient, getRegiondoRetryDelayMs, isRetryableRegiondoStatus } from './client.js';

test('getRegiondoRetryDelayMs grows exponentially and caps the wait time', () => {
  assert.equal(getRegiondoRetryDelayMs(0, 250), 250);
  assert.equal(getRegiondoRetryDelayMs(2, 250), 1000);
  assert.equal(getRegiondoRetryDelayMs(10, 1000), 5000);
});

test('isRetryableRegiondoStatus only retries transient status codes', () => {
  assert.equal(isRetryableRegiondoStatus(408), true);
  assert.equal(isRetryableRegiondoStatus(429), true);
  assert.equal(isRetryableRegiondoStatus(503), true);
  assert.equal(isRetryableRegiondoStatus(400), false);
});

test('RegiondoClient retries retryable responses and eventually returns data', async () => {
  let attempts = 0;

  const client = new RegiondoClient({
    baseUrl: 'https://example.com/v1',
    publicKey: 'public-key',
    privateKey: 'private-key',
    language: 'de-DE',
    requestTimeoutMs: 1000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    sleep: async () => undefined,
    fetchImplementation: async () => {
      attempts += 1;

      if (attempts === 1) {
        return new Response('temporary outage', { status: 503 });
      }

      return new Response(JSON.stringify({ data: [{ id: 'product-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const products = await client.getCollection<{ id: string }>('/products');

  assert.equal(attempts, 2);
  assert.deepEqual(products, [{ id: 'product-1' }]);
});

test('RegiondoClient does not retry non-retryable responses', async () => {
  let attempts = 0;

  const client = new RegiondoClient({
    baseUrl: 'https://example.com/v1',
    publicKey: 'public-key',
    privateKey: 'private-key',
    language: 'de-DE',
    requestTimeoutMs: 1000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    sleep: async () => undefined,
    fetchImplementation: async () => {
      attempts += 1;
      return new Response('bad request', { status: 400 });
    }
  });

  await assert.rejects(client.getCollection('/products'), /Regiondo request failed 400: bad request/);
  assert.equal(attempts, 1);
});
