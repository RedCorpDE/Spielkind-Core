import { describe, expect, it, vi } from 'vitest';
import { StripePaymentProvider } from '../../src/modules/integrations/payment-providers/stripe/stripe-payment-provider.js';

describe('Stripe payment provider', () => {
  it('creates a hosted Checkout Session with authoritative amount and idempotency', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay', expires_at: 1_800_000_000
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new StripePaymentProvider({
      secretKey: 'sk_test_example', apiBaseUrl: 'https://api.stripe.test', requestTimeoutMs: 1000
    }, request as typeof fetch);

    const result = await provider.createCheckout({
      bookingId: '2a9d7a07-dc3b-4855-8c0e-9f94c6288df7',
      amountMinor: 1299,
      currency: 'EUR',
      idempotencyKey: 'checkout-request-1',
      description: 'Play session',
      customerEmail: 'client@example.test',
      successUrl: 'https://shop.example/success',
      cancelUrl: 'https://shop.example/cancel'
    });

    expect(result.externalCheckoutId).toBe('cs_test_1');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.stripe.test/v1/checkout/sessions');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('checkout-request-1');
    const form = new URLSearchParams(init?.body as string);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('1299');
    expect(form.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(form.get('metadata[booking_id]')).toBe('2a9d7a07-dc3b-4855-8c0e-9f94c6288df7');
  });

  it('creates a PaymentIntent for the WordPress Payment Element without trusting browser totals', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      id: 'pi_test_1', client_secret: 'pi_test_1_secret_value', status: 'requires_payment_method',
      amount: 4200, currency: 'eur'
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new StripePaymentProvider({
      secretKey: 'sk_test_example', apiBaseUrl: 'https://api.stripe.test', requestTimeoutMs: 1000
    }, request as typeof fetch);

    const result = await provider.createPaymentIntent({
      bookingId: '2a9d7a07-dc3b-4855-8c0e-9f94c6288df7',
      locationId: 'af79d0f6-cb17-4f98-8a72-cf4fa217fc7f',
      productId: '431d4598-cf62-4ff4-bf84-40eb10693bf0',
      amountMinor: 4200, currency: 'EUR', idempotencyKey: 'web-payment-1',
      description: 'Play session', customerEmail: 'guest@example.test'
    });

    expect(result.clientSecret).toBe('pi_test_1_secret_value');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.stripe.test/v1/payment_intents');
    const form = new URLSearchParams(init?.body as string);
    expect(form.get('amount')).toBe('4200');
    expect(form.get('metadata[booking_id]')).toBe('2a9d7a07-dc3b-4855-8c0e-9f94c6288df7');
    expect(form.has('price')).toBe(false);
  });
});
