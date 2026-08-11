import { describe, expect, it } from 'vitest';
import { discoverRegiondoLocationFields } from '../../src/modules/regiondo/regiondo-location-diagnostics.js';

describe('Regiondo location diagnostics', () => {
  it('returns location identifiers and labels without unrelated customer data', () => {
    const fields = discoverRegiondoLocationFields([
      {
        source: 'booking',
        raw: {
          contact_data: { email: 'customer@example.com', firstname: 'Customer' },
          supplierBookings: [
            { location: { id: 4711, name: 'Berlin Mitte' }, booking_key: 'secret-booking-key' }
          ]
        }
      },
      {
        source: 'product',
        raw: { city: 'Berlin', city_id: 42, location_address: 'Alexanderplatz' }
      }
    ]);

    expect(fields).toEqual(expect.arrayContaining([
      { path: 'supplierBookings.[0].location.id', source: 'booking', value: '4711' },
      { path: 'supplierBookings.[0].location.name', source: 'booking', value: 'Berlin Mitte' },
      { path: 'city_id', source: 'product', value: '42' }
    ]));
    expect(JSON.stringify(fields)).not.toContain('customer@example.com');
    expect(JSON.stringify(fields)).not.toContain('secret-booking-key');
  });
});
