import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}));

import {
  RegiondoAuthError,
  RegiondoClient,
  RegiondoPayloadError,
  RegiondoPurchaseRecoveryRequiredError
} from '../../src/modules/regiondo/regiondo.client.js';

const createCompletePurchaseSnapshot = () => ({
  info_generated_at: '2026-05-07T10:00:00.000Z',
  items: [
    {
      booking_key: 'booking-key-1',
      payment_status: 'paid',
      price_per_one_incl_tax: 19.9,
      product_id: '297021',
      row_total_incl_tax: 19.9,
      ticket_qty: 1
    }
  ],
  order_id: '4711',
  order_number: 'R-10001',
  payment_method: 'API external payment',
  purchased_at: '2026-05-07T10:00:00.000Z',
  sales_channel: 'API'
});

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

  it('keeps transport retries enabled for safe GET requests', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response('Regiondo unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'product-1' } }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );
    const sleepImplementation = vi.fn(async () => undefined);
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 2,
      publicKey: 'public-key',
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: sleepImplementation,
      supplierId: '15241'
    });

    await expect(client.getObject<{ id: string }>('/products/product-1')).resolves.toEqual({ id: 'product-1' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleepImplementation).toHaveBeenCalledWith(1);
  });

  it('unwraps wrapped checkout purchase payloads before validating them', async () => {
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            full_purchase_data: {
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
            }
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

    const purchase = await client.purchaseOrder({
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
    });

    expect(purchase.order_number).toBe('R-10001');
    expect(purchase.items[0]?.booking_key).toBe('booking-key-1');
  });

  it('hydrates the canonical purchase snapshot when the checkout POST only returns an order receipt', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            order_id: '4711',
            order_number: 'R-10001',
            result: 'ok'
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
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
            }
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        )
      );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
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

    const purchase = await client.purchaseOrder({
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
    });

    const hydrateUrl = new URL(String(fetchImplementation.mock.calls[1]?.[0]));
    expect(hydrateUrl.pathname).toBe('/v1/checkout/purchase');
    expect(hydrateUrl.searchParams.get('order_number')).toBe('R-10001');
    expect(purchase.order_number).toBe('R-10001');
    expect(purchase.items[0]?.booking_key).toBe('booking-key-1');
  });

  it('hydrates nested Regiondo checkout receipts and nested purchase snapshots', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              order: {
                id: '4711',
                number: 'R-10001'
              }
            },
            success: true
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              full_purchase_data: {
                info_generated_at: '2026-05-07T10:00:00.000Z',
                items: [
                  {
                    booking_key: 'booking-key-1',
                    payment_status: 'paid',
                    price_per_one_incl_tax: 19.9,
                    product_id: '297021',
                    row_total_incl_tax: 19.9,
                    ticket_qty: 1
                  }
                ],
                order_id: '4711',
                order_number: 'R-10001',
                payment_method: 'API external payment',
                purchased_at: '2026-05-07T10:00:00.000Z',
                sales_channel: 'API'
              }
            }
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        )
      );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
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

    const purchase = await client.purchaseOrder({
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
    });

    const hydrateUrl = new URL(String(fetchImplementation.mock.calls[1]?.[0]));
    expect(hydrateUrl.pathname).toBe('/v1/checkout/purchase');
    expect(hydrateUrl.searchParams.get('order_number')).toBe('R-10001');
    expect(purchase.order_number).toBe('R-10001');
    expect(purchase.items[0]?.booking_key).toBe('booking-key-1');
  });

  it('accepts JSON checkout responses with a non-JSON content type', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            order_id: '4711',
            order_number: 'R-10001',
            result: 'ok'
          }),
          {
            headers: { 'content-type': 'text/plain; charset=UTF-8' },
            status: 200
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              info_generated_at: '2026-05-07T10:00:00.000Z',
              items: [
                {
                  booking_key: 'booking-key-1',
                  payment_status: 'paid',
                  price_per_one_incl_tax: 19.9,
                  product_id: '297021',
                  row_total_incl_tax: 19.9,
                  ticket_qty: 1
                }
              ],
              order_id: '4711',
              order_number: 'R-10001',
              payment_method: 'API external payment',
              purchased_at: '2026-05-07T10:00:00.000Z',
              sales_channel: 'API'
            }
          }),
          {
            headers: { 'content-type': 'text/plain; charset=UTF-8' },
            status: 200
          }
        )
      );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
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

    const purchase = await client.purchaseOrder({
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
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(purchase.order_number).toBe('R-10001');
    expect(purchase.items[0]?.booking_key).toBe('booking-key-1');
  });

  it('accepts double-encoded JSON checkout responses', async () => {
    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify(
            JSON.stringify({
              info_generated_at: '2026-05-07T10:00:00.000Z',
              items: [
                {
                  booking_key: 'booking-key-1',
                  payment_status: 'paid',
                  price_per_one_incl_tax: 19.9,
                  product_id: '297021',
                  row_total_incl_tax: 19.9,
                  ticket_qty: 1
                }
              ],
              order_id: '4711',
              order_number: 'R-10001',
              payment_method: 'API external payment',
              purchased_at: '2026-05-07T10:00:00.000Z',
              sales_channel: 'API'
            })
          ),
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

    const purchase = await client.purchaseOrder({
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
    });

    expect(purchase.order_number).toBe('R-10001');
    expect(purchase.items[0]?.booking_key).toBe('booking-key-1');
  });

  it('polls incomplete purchase snapshots without replaying the checkout POST', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_id: '4711', order_number: 'R-10001', result: 'ok' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_id: '4711', order_number: 'R-10001', result: 'processing' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_id: '4711', order_number: 'R-10001', result: 'processing' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: createCompletePurchaseSnapshot() }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 3,
      publicKey: 'public-key',
      purchaseHydrationMaxAttempts: 5,
      purchaseHydrationRetryBaseDelayMs: 1,
      purchaseHydrationTimeoutMs: 10_000,
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    const purchase = await client.purchaseOrder({
      contactData: {
        email: 'booking@example.com',
        firstname: 'Jamie',
        lastname: 'Rivera'
      },
      items: [{ product_id: 297021, qty: 1 }],
      subId: 'task-1'
    });

    const methods = fetchImplementation.mock.calls.map(([, init]) => init?.method);
    expect(methods).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(purchase.order_number).toBe('R-10001');
  });

  it('polls supplier bookings when the checkout receipt only contains an order id', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_id: '4711', result: 'ok' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ booking_key: 'booking-key-1', order_number: 'R-10001' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_id: '4711', order_number: 'R-10001', result: 'processing' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createCompletePurchaseSnapshot()), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
      purchaseHydrationMaxAttempts: 5,
      purchaseHydrationRetryBaseDelayMs: 1,
      purchaseHydrationTimeoutMs: 10_000,
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    const purchase = await client.purchaseOrder({
      contactData: {
        email: 'booking@example.com',
        firstname: 'Jamie',
        lastname: 'Rivera'
      },
      items: [{ product_id: 297021, qty: 1 }]
    });

    const urls = fetchImplementation.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.pathname)).toEqual([
      '/v1/checkout/purchase',
      '/v1/supplier/bookings',
      '/v1/supplier/bookings',
      '/v1/checkout/purchase',
      '/v1/checkout/purchase'
    ]);
    expect(purchase.order_number).toBe('R-10001');
  });

  it('does not replay a checkout POST after an ambiguous timeout', async () => {
    const timeoutError = new Error('The operation timed out.');
    timeoutError.name = 'AbortError';
    const fetchImplementation = vi.fn().mockRejectedValue(timeoutError);

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 5,
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
        items: [{ product_id: 297021, qty: 1 }],
        subId: 'task-1'
      })
    ).rejects.toMatchObject({
      reason: 'post_outcome_unknown',
      retryable: false,
      subId: 'task-1'
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('does not replay a checkout POST after a Regiondo 503 response', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response('Regiondo unavailable', {
        status: 503
      })
    );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 5,
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
        items: [{ product_id: 297021, qty: 1 }]
      })
    ).rejects.toBeInstanceOf(RegiondoPurchaseRecoveryRequiredError);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('retries transient hydration GET failures but stops immediately on authentication failures', async () => {
    const successFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_number: 'R-10001', result: 'ok' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(new Response('Regiondo unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createCompletePurchaseSnapshot()), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );

    const successClient = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: successFetch,
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
      purchaseHydrationRetryBaseDelayMs: 1,
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    await expect(
      successClient.purchaseOrder({
        contactData: {
          email: 'booking@example.com',
          firstname: 'Jamie',
          lastname: 'Rivera'
        },
        items: [{ product_id: 297021, qty: 1 }]
      })
    ).resolves.toMatchObject({ order_number: 'R-10001' });
    expect(successFetch).toHaveBeenCalledTimes(3);

    const authFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ order_number: 'R-10001', result: 'ok' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      )
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const authClient = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation: authFetch,
      language: 'de-DE',
      maxRetries: 5,
      publicKey: 'public-key',
      requestThrottleMs: 0,
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 1,
      secretKey: 'secret-key',
      sleep: async () => undefined,
      supplierId: '15241'
    });

    await expect(
      authClient.purchaseOrder({
        contactData: {
          email: 'booking@example.com',
          firstname: 'Jamie',
          lastname: 'Rivera'
        },
        items: [{ product_id: 297021, qty: 1 }]
      })
    ).rejects.toBeInstanceOf(RegiondoAuthError);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('returns a reconciliation-required error when purchase hydration is exhausted', async () => {
    const fetchImplementation = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            order_id: '4711',
            order_number: 'R-10001',
            result: 'processing'
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200
          }
        )
    );

    const client = new RegiondoClient({
      baseUrl: 'https://example.com/v1',
      currency: 'EUR',
      fetchImplementation,
      language: 'de-DE',
      maxRetries: 0,
      publicKey: 'public-key',
      purchaseHydrationMaxAttempts: 3,
      purchaseHydrationRetryBaseDelayMs: 1,
      purchaseHydrationTimeoutMs: 10_000,
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
        ],
        subId: 'task-1'
      })
    ).rejects.toMatchObject({
      attemptCount: 3,
      cause: expect.any(RegiondoPayloadError),
      orderId: '4711',
      orderNumber: 'R-10001',
      reason: 'snapshot_unavailable',
      retryable: false,
      subId: 'task-1'
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });
});
