import { z } from 'zod';
import { appConfig } from '../../../../config/env.js';
import { ProviderUnavailableError } from '../../../bookings/booking.errors.js';
import type { PaymentCheckout, PaymentProvider } from '../../../payments/payment-provider.js';

type FetchLike = typeof fetch;

interface StripeProviderConfig {
  secretKey?: string;
  apiBaseUrl: string;
  requestTimeoutMs: number;
}

const checkoutSessionSchema = z.object({
  id: z.string().min(1),
  url: z.string().nullable().optional(),
  expires_at: z.number().int().nullable().optional()
});

const paymentIntentSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  client_secret: z.string().min(1).optional()
});

const refundSchema = z.object({ id: z.string().min(1), status: z.string().nullable().optional() });

export class StripeApiError extends ProviderUnavailableError {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryable = true
  ) {
    super(message);
  }
}

function appendFormValue(form: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value !== undefined) form.append(key, String(value));
}

export class StripePaymentProvider implements PaymentProvider {
  readonly key = 'stripe' as const;

  constructor(
    private readonly config: StripeProviderConfig = {
      secretKey: appConfig.STRIPE_SECRET_KEY,
      apiBaseUrl: appConfig.STRIPE_API_BASE_URL,
      requestTimeoutMs: appConfig.STRIPE_REQUEST_TIMEOUT_MS
    },
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async request(path: string, init: RequestInit, idempotencyKey?: string): Promise<unknown> {
    if (!this.config.secretKey) throw new ProviderUnavailableError('Stripe is not configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...init.headers
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string; type?: string } } | null;
      if (!response.ok) {
        const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
        throw new StripeApiError(
          payload?.error?.message ? `Stripe request failed: ${payload.error.message}` : `Stripe request failed with status ${response.status}.`,
          response.status,
          retryable
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof StripeApiError) throw error;
      throw new StripeApiError(error instanceof Error && error.name === 'AbortError' ? 'Stripe request timed out.' : 'Stripe is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }

  async createCheckout(input: {
    bookingId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<PaymentCheckout> {
    const form = new URLSearchParams();
    appendFormValue(form, 'mode', 'payment');
    appendFormValue(form, 'client_reference_id', input.bookingId);
    appendFormValue(form, 'metadata[booking_id]', input.bookingId);
    appendFormValue(form, 'payment_intent_data[metadata][booking_id]', input.bookingId);
    appendFormValue(form, 'line_items[0][price_data][currency]', input.currency.toLowerCase());
    appendFormValue(form, 'line_items[0][price_data][unit_amount]', input.amountMinor);
    appendFormValue(form, 'line_items[0][price_data][product_data][name]', input.description);
    appendFormValue(form, 'line_items[0][quantity]', 1);
    appendFormValue(form, 'success_url', input.successUrl);
    appendFormValue(form, 'cancel_url', input.cancelUrl);
    appendFormValue(form, 'customer_email', input.customerEmail);

    const session = checkoutSessionSchema.parse(await this.request(
      '/v1/checkout/sessions',
      { method: 'POST', body: form },
      input.idempotencyKey
    ));
    return {
      externalCheckoutId: session.id,
      redirectUrl: session.url ?? null,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null
    };
  }

  async createPaymentIntent(input: {
    bookingId: string;
    locationId: string;
    productId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    customerEmail?: string;
  }) {
    const form = new URLSearchParams();
    appendFormValue(form, 'amount', input.amountMinor);
    appendFormValue(form, 'currency', input.currency.toLowerCase());
    appendFormValue(form, 'description', input.description);
    appendFormValue(form, 'receipt_email', input.customerEmail);
    appendFormValue(form, 'automatic_payment_methods[enabled]', 'true');
    appendFormValue(form, 'metadata[booking_id]', input.bookingId);
    appendFormValue(form, 'metadata[location_id]', input.locationId);
    appendFormValue(form, 'metadata[product_id]', input.productId);
    const intent = paymentIntentSchema.parse(await this.request(
      '/v1/payment_intents',
      { method: 'POST', body: form },
      input.idempotencyKey
    ));
    if (!intent.client_secret) throw new StripeApiError('Stripe did not return a PaymentIntent client secret.', 502, false);
    return { externalPaymentId: intent.id, clientSecret: intent.client_secret, status: intent.status };
  }

  async retrievePayment(externalPaymentId: string): Promise<{ status: string; amountMinor: number; currency: string }> {
    const intent = paymentIntentSchema.parse(await this.request(
      `/v1/payment_intents/${encodeURIComponent(externalPaymentId)}`,
      { method: 'GET' }
    ));
    return { status: intent.status, amountMinor: intent.amount, currency: intent.currency.toUpperCase() };
  }

  async refund(input: {
    externalPaymentId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    bookingId?: string;
  }): Promise<{ externalRefundId: string; status: string }> {
    const form = new URLSearchParams();
    appendFormValue(form, 'payment_intent', input.externalPaymentId);
    appendFormValue(form, 'amount', input.amountMinor);
    appendFormValue(form, 'metadata[booking_id]', input.bookingId);
    const refund = refundSchema.parse(await this.request('/v1/refunds', { method: 'POST', body: form }, input.idempotencyKey));
    return { externalRefundId: refund.id, status: refund.status ?? 'pending' };
  }
}

export const stripePaymentProvider = new StripePaymentProvider();
