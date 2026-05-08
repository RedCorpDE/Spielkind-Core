import { describe, expect, it } from 'vitest';
import { RegiondoClient, RegiondoPayloadError } from '../../src/modules/regiondo/regiondo.client.js';

describe('RegiondoClient checkout actions', () => {
  it('posts checkout purchases with signed query params and JSON body', async () => {
    let observedMethod = '';
    let observedUrl: URL | null = null;
    let observedBody: Record<string, unknown> | null = null;

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async (input, init) => {
        observedMethod = init?.method ?? '';
        observedUrl = new URL(typeof input === 'string' ? input : input.toString());
        observedBody = init?.body ? JSON.parse(String(init.body)) : null;

        return new Response(
          JSON.stringify({
            info_generated_at: '2026-05-07T10:00:00.000Z',
            items: [
              {
                booking_key: 'booking-key-1',
                payment_status: 'paid',
                price_per_one_incl_tax: 19.9,
                product_id: '297021',
                row_total_incl_tax: 39.8,
                ticket_qty: 2
              }
            ],
            order_id: '4711',
            order_number: 'R-10001',
            payment_method: 'API external payment',
            purchased_at: '2026-05-07T10:00:00.000Z',
            sales_channel: 'API'
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        );
      },
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

    const purchase = await client.purchaseOrder({
      comment: 'Created from task drawer',
      contactData: {
        email: 'booking@example.com',
        firstname: 'Jamie',
        lastname: 'Rivera',
        telephone: '+491234567'
      },
      items: [
        {
          date_time: '2026-05-10 18:00',
          option_id: 720707,
          product_id: 297021,
          qty: 2
        }
      ],
      sendTicketsToCustomer: false,
      storeLocale: 'de-DE',
      subId: 'task-1',
      syncTicketsProcessing: true
    });

    expect(observedMethod).toBe('POST');
    expect(observedUrl?.pathname).toBe('/v1/checkout/purchase');
    expect(observedUrl?.searchParams.get('currency')).toBe('EUR');
    expect(observedUrl?.searchParams.get('store_locale')).toBe('de-DE');
    expect(observedBody).toEqual({
      comment: 'Created from task drawer',
      contact_data: {
        email: 'booking@example.com',
        firstname: 'Jamie',
        lastname: 'Rivera',
        telephone: '+491234567'
      },
      items: [
        {
          date_time: '2026-05-10 18:00',
          option_id: 720707,
          product_id: 297021,
          qty: 2
        }
      ],
      send_tickets_to_customer: false,
      sub_id: 'task-1',
      sync_tickets_processing: true
    });
    expect(purchase.order_number).toBe('R-10001');
  });

  it('posts Regiondo ticket cancellations by reference id list', async () => {
    let observedMethod = '';
    let observedUrl: URL | null = null;

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async (input, init) => {
        observedMethod = init?.method ?? '';
        observedUrl = new URL(typeof input === 'string' ? input : input.toString());

        return new Response(JSON.stringify({ result: 'ok' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        });
      },
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

    await client.cancelTickets(['ref-1', 'ref-2']);

    expect(observedMethod).toBe('POST');
    expect(observedUrl?.pathname).toBe('/v1/checkout/cancel');
    expect(observedUrl?.searchParams.get('reference_ids')).toBe('ref-1,ref-2');
  });

  it('surfaces invalid Regiondo purchase payloads as structured provider errors', async () => {
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            order_id: '4711',
            order_number: 'R-10001'
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        ),
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

    await expect(
      client.purchaseOrder({
        contactData: {
          email: 'booking@example.com',
          firstname: 'Jamie',
          lastname: 'Rivera'
        },
        items: [
          {
            product_id: 297021,
            qty: 1
          }
        ]
      })
    ).rejects.toBeInstanceOf(RegiondoPayloadError);

    await expect(
      client.purchaseOrder({
        contactData: {
          email: 'booking@example.com',
          firstname: 'Jamie',
          lastname: 'Rivera'
        },
        items: [
          {
            product_id: 297021,
            qty: 1
          }
        ]
      })
    ).rejects.toMatchObject({
      message: 'Regiondo purchase response payload did not match the expected shape.',
      responseBody: expect.stringContaining('items')
    });
  });
});
