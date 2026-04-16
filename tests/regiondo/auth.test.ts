import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { signRegiondoRequest, verifyWebhookSignature } from '../../src/regiondo/auth.js';

const SECRET = 'test-secret-key';
const PUBLIC_KEY = 'test-public';
const PRIVATE_KEY = 'test-private';

function makeSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('signRegiondoRequest', () => {
  it('produces a hex HMAC-SHA256 string', () => {
    const timestamp = 1700000000;
    const queryParams = new URLSearchParams({ lang: 'de-DE' });
    const result = signRegiondoRequest({ timestamp, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, queryParams });

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for identical inputs', () => {
    const timestamp = 1700000000;
    const queryParams = new URLSearchParams({ lang: 'de-DE' });
    const first = signRegiondoRequest({ timestamp, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, queryParams });
    const second = signRegiondoRequest({ timestamp, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, queryParams });

    expect(first).toBe(second);
  });

  it('produces a different hash when the timestamp changes', () => {
    const queryParams = new URLSearchParams();
    const a = signRegiondoRequest({ timestamp: 1700000000, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, queryParams });
    const b = signRegiondoRequest({ timestamp: 1700000001, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, queryParams });

    expect(a).not.toBe(b);
  });

  it('produces a different hash when the private key changes', () => {
    const timestamp = 1700000000;
    const queryParams = new URLSearchParams();
    const a = signRegiondoRequest({ timestamp, publicKey: PUBLIC_KEY, privateKey: 'key-a', queryParams });
    const b = signRegiondoRequest({ timestamp, publicKey: PUBLIC_KEY, privateKey: 'key-b', queryParams });

    expect(a).not.toBe(b);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a valid HMAC signature', () => {
    const payload = JSON.stringify({ event: 'booking.created', id: 'abc123' });
    const signature = makeSignature(payload, SECRET);

    expect(verifyWebhookSignature(payload, signature, SECRET)).toBe(true);
  });

  it('rejects an incorrect signature', () => {
    const payload = JSON.stringify({ event: 'booking.created', id: 'abc123' });
    const wrongSignature = makeSignature(payload, 'wrong-secret');

    expect(verifyWebhookSignature(payload, wrongSignature, SECRET)).toBe(false);
  });

  it('rejects when the signature header is missing (undefined)', () => {
    const payload = JSON.stringify({ event: 'booking.created' });

    expect(verifyWebhookSignature(payload, undefined, SECRET)).toBe(false);
  });

  it('rejects when the signature header is an empty string', () => {
    const payload = JSON.stringify({ event: 'booking.created' });

    expect(verifyWebhookSignature(payload, '', SECRET)).toBe(false);
  });

  it('rejects when payload has been tampered after signing', () => {
    const originalPayload = JSON.stringify({ event: 'booking.created', id: 'abc' });
    const tamperedPayload = JSON.stringify({ event: 'booking.created', id: 'xyz' });
    const signature = makeSignature(originalPayload, SECRET);

    expect(verifyWebhookSignature(tamperedPayload, signature, SECRET)).toBe(false);
  });

  it('replay attack: same valid signature accepted each call (no server-side state in auth module)', () => {
    // verifyWebhookSignature is stateless — replay deduplication must be enforced
    // at a higher layer (e.g. storing processed event IDs). This test documents
    // that a second identical call still returns true, making clear the responsibility
    // for replay protection lies outside this module.
    const payload = JSON.stringify({ event: 'booking.created', id: 'abc123' });
    const signature = makeSignature(payload, SECRET);

    const first = verifyWebhookSignature(payload, signature, SECRET);
    const second = verifyWebhookSignature(payload, signature, SECRET);

    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
