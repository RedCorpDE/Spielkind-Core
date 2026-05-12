import { describe, expect, it } from 'vitest';
import { regiondoSupplierBookingsSchema } from '../../src/modules/regiondo/regiondo.types.js';

describe('regiondoSupplierBookingsSchema', () => {
  it('accepts nullable optional contact fields from Regiondo supplier bookings', () => {
    const parsed = regiondoSupplierBookingsSchema.parse([
      {
        booking_key: 'booking-key-1',
        order_number: 'R-10001',
        email: null,
        first_name: null,
        last_name: null,
        phone_number: null,
        product_id: '297021',
        status: 'approved'
      }
    ]);

    expect(parsed).toEqual([
      {
        booking_key: 'booking-key-1',
        order_number: 'R-10001',
        product_id: '297021',
        status: 'approved'
      }
    ]);
  });
});
