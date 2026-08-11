import { describe, expect, it } from 'vitest';
import { RegiondoClient } from '../../src/modules/regiondo/regiondo.client.js';

const enabled = process.env.REGIONDO_SANDBOX_UPDATE_CONTRACT === '1';
const contractTest = enabled ? it : it.skip;

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when REGIONDO_SANDBOX_UPDATE_CONTRACT=1.`);
  }
  return value;
}

describe('Regiondo sandbox booking update contract', () => {
  contractTest('accepts the private supplier booking PUT with an explicit mapped location', async () => {
    const client = new RegiondoClient({
      baseUrl: requiredEnvironmentValue('REGIONDO_SANDBOX_BASE_URL'),
      currency: process.env.REGIONDO_SANDBOX_CURRENCY?.trim() || 'EUR',
      language: process.env.REGIONDO_SANDBOX_LANGUAGE?.trim() || 'de-DE',
      maxRetries: 0,
      publicKey: requiredEnvironmentValue('REGIONDO_SANDBOX_PUBLIC_KEY'),
      requestThrottleMs: 0,
      requestTimeoutMs: 30_000,
      secretKey: requiredEnvironmentValue('REGIONDO_SANDBOX_SECRET_KEY'),
      supplierId: requiredEnvironmentValue('REGIONDO_SANDBOX_SUPPLIER_ID')
    });

    const response = await client.updateBooking({
      bookingKey: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_KEY'),
      contactData: {
        email: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_EMAIL'),
        firstname: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_FIRST_NAME'),
        lastname: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_LAST_NAME')
      },
      endsAt: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_ENDS_AT'),
      guestCount: Number(requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_GUEST_COUNT')),
      locationId: requiredEnvironmentValue('REGIONDO_SANDBOX_LOCATION_ID'),
      orderNumber: process.env.REGIONDO_SANDBOX_ORDER_NUMBER?.trim() || null,
      startsAt: requiredEnvironmentValue('REGIONDO_SANDBOX_BOOKING_STARTS_AT')
    });

    expect(response).toBeDefined();
  });
});
