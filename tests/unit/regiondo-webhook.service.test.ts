import { describe, expect, it } from 'vitest';
import { buildRegiondoWebhookDedupeKey } from '../../src/modules/regiondo/regiondo-webhook.service.js';

describe('buildRegiondoWebhookDedupeKey', () => {
  it('is stable for equivalent payloads with different key ordering', () => {
    const payloadA = {
      channel: 'webhook',
      action_type: 'booking.updated',
      full_purchase_data: {
        order_number: 'ORDER-1',
        info_generated_at: '2026-05-01T10:00:00.000Z',
        items: [
          {
            booking_key: 'BOOKING-1',
            status: 'approved'
          }
        ]
      }
    };

    const payloadB = {
      full_purchase_data: {
        items: [
          {
            status: 'approved',
            booking_key: 'BOOKING-1'
          }
        ],
        info_generated_at: '2026-05-01T10:00:00.000Z',
        order_number: 'ORDER-1'
      },
      action_type: 'booking.updated',
      channel: 'webhook'
    };

    expect(buildRegiondoWebhookDedupeKey(payloadA, 'BOOKING-1')).toBe(
      buildRegiondoWebhookDedupeKey(payloadB, 'BOOKING-1')
    );
  });

  it('changes when the booking key changes', () => {
    const payload = {
      channel: 'webhook',
      action_type: 'booking.updated',
      full_purchase_data: {
        order_number: 'ORDER-1',
        info_generated_at: '2026-05-01T10:00:00.000Z',
        items: [{ booking_key: 'BOOKING-1', status: 'approved' }]
      }
    };

    expect(buildRegiondoWebhookDedupeKey(payload, 'BOOKING-1')).not.toBe(
      buildRegiondoWebhookDedupeKey(payload, 'BOOKING-2')
    );
  });
});
