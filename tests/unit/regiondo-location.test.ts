import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}));

import { RegiondoClient, RegiondoLocationValidationError } from '../../src/modules/regiondo/regiondo.client.js';
import { getProductLocation } from '../../src/modules/regiondo/regiondo.types.js';

const location = (overrides: Record<string, unknown> = {}) => ({
  id: 123,
  location_type: 'city',
  is_general: 0,
  location_name: 'Braunschweig',
  country_code: 'DE',
  url_key: 'braunschweig',
  url_path: '/deutschland/braunschweig',
  ...overrides
});

const createClient = (fetchImplementation: typeof fetch) => new RegiondoClient({
  baseUrl: 'https://api.regiondo.test/v1',
  currency: 'EUR',
  fetchImplementation,
  language: 'de-DE',
  maxRetries: 0,
  publicKey: 'public-key',
  requestThrottleMs: 0,
  requestTimeoutMs: 1_000,
  retryBaseDelayMs: 1,
  secretKey: 'secret-key',
  sleep: async () => undefined,
  supplierId: '15241'
});

describe('getProductLocation', () => {
  it('converts city_id and region_id into typed location references', () => {
    expect(getProductLocation({ city_id: 123 }, 'city')).toEqual({ locationId: 123, locationType: 'city' });
    expect(getProductLocation({ region_id: 456 }, 'region')).toEqual({ locationId: 456, locationType: 'region' });
  });

  it('rejects missing and invalid IDs', () => {
    expect(() => getProductLocation({}, 'city')).toThrow(/missing city_id/);
    expect(() => getProductLocation({}, 'region')).toThrow(/missing region_id/);
    for (const value of [0, -1, 1.5, 'abc']) {
      expect(() => getProductLocation({ city_id: value }, 'city')).toThrow(/positive integer/);
    }
  });
});

describe('Regiondo location API', () => {
  it('serializes GET /locations query parameters and caps the page size at 250', async () => {
    let observedUrl: URL | null = null;
    const client = createClient(async (input) => {
      observedUrl = new URL(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ data: [location()] }), {
        headers: { 'content-type': 'application/json' },
        status: 200
      });
    });

    await expect(client.getLocations({
      countryCode: 'DE',
      isGeneral: 0,
      limit: 500,
      locationType: 'city',
      offset: 25
    })).resolves.toEqual([location()]);
    expect(observedUrl?.pathname).toBe('/v1/locations');
    expect(observedUrl?.searchParams.get('limit')).toBe('250');
    expect(observedUrl?.searchParams.get('offset')).toBe('25');
    expect(observedUrl?.searchParams.get('location_type')).toBe('city');
    expect(observedUrl?.searchParams.get('is_general')).toBe('0');
    expect(observedUrl?.searchParams.get('country_code')).toBe('DE');
  });

  it('accepts a validated city and rejects a location type mismatch', async () => {
    const cityClient = createClient(async () => new Response(JSON.stringify({ data: location() }), {
      headers: { 'content-type': 'application/json' }, status: 200
    }));
    await expect(cityClient.validateLocation(123, 'city')).resolves.toMatchObject({ id: 123, location_type: 'city' });

    const regionClient = createClient(async () => new Response(JSON.stringify({ data: location({ location_type: 'region' }) }), {
      headers: { 'content-type': 'application/json' }, status: 200
    }));
    await expect(regionClient.validateLocation(123, 'city')).rejects.toBeInstanceOf(RegiondoLocationValidationError);
    await expect(regionClient.validateLocation(123, 'city')).rejects.toThrow(/region, not a city/);
  });

  it('turns a Regiondo location 404 into a typed validation error', async () => {
    const client = createClient(async () => new Response('Not Found', { status: 404 }));
    await expect(client.validateLocation(999)).rejects.toThrow(/location ID 999 was not found/);
  });
});
