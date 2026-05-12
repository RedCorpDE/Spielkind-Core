import { describe, expect, it } from 'vitest';
import { normalizeRegiondoBookingImport } from '../../src/modules/bookings/booking-normalizer.js';
import { RegiondoPayloadError } from '../../src/modules/regiondo/regiondo.client.js';

describe('normalizeRegiondoBookingImport', () => {
  it('surfaces booking-key mismatches as structured Regiondo payload errors', () => {
    expect(() =>
      normalizeRegiondoBookingImport({
        bookingKey: 'booking-key-1',
        purchaseData: {
          info_generated_at: '2026-05-12T10:00:00.000Z',
          items: [
            {
              booking_key: 'booking-key-2',
              payment_status: 'paid',
              price_per_one_incl_tax: 19.9,
              product_id: '297021',
              row_total_incl_tax: 39.8,
              ticket_qty: 2
            }
          ],
          order_number: 'R-10001',
          payment_method: 'API external payment',
          purchased_at: '2026-05-12T10:00:00.000Z',
          sales_channel: 'API'
        },
        supplierBookings: [
          {
            booking_key: 'booking-key-1',
            order_number: 'R-10001',
            product_id: '297021',
            qty: 2,
            status: 'confirmed'
          }
        ],
        webhookPayload: null
      })
    ).toThrow(RegiondoPayloadError);

    try {
      normalizeRegiondoBookingImport({
        bookingKey: 'booking-key-1',
        purchaseData: {
          info_generated_at: '2026-05-12T10:00:00.000Z',
          items: [
            {
              booking_key: 'booking-key-2',
              payment_status: 'paid',
              price_per_one_incl_tax: 19.9,
              product_id: '297021',
              row_total_incl_tax: 39.8,
              ticket_qty: 2
            }
          ],
          order_number: 'R-10001',
          payment_method: 'API external payment',
          purchased_at: '2026-05-12T10:00:00.000Z',
          sales_channel: 'API'
        },
        supplierBookings: [
          {
            booking_key: 'booking-key-1',
            order_number: 'R-10001',
            product_id: '297021',
            qty: 2,
            status: 'confirmed'
          }
        ],
        webhookPayload: null
      });

      throw new Error('Expected normalizeRegiondoBookingImport to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(RegiondoPayloadError);
      expect(error).toMatchObject({
        message: 'Regiondo booking snapshot could not be normalized.',
        responseBody: 'Purchase snapshot does not contain booking key booking-key-1.'
      });
    }
  });
});
