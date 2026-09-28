import { z } from 'zod';
import { confirmStripePayment, updateStripePaymentState } from '../../../payments/payment-confirmation.service.js';

const stripeObjectSchema = z.record(z.unknown());
export const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({ object: stripeObjectSchema })
}).passthrough();

function stringValue(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value ? value : undefined;
}

function integerValue(object: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

function objectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

function bookingId(object: Record<string, unknown>): string | undefined {
  const direct = stringValue(object, 'client_reference_id');
  const metadata = object.metadata;
  const fromMetadata = typeof metadata === 'object' && metadata !== null
    ? stringValue(metadata as Record<string, unknown>, 'booking_id')
    : undefined;
  const candidate = direct ?? fromMetadata;
  return candidate && z.string().uuid().safeParse(candidate).success ? candidate : undefined;
}

export interface NormalizedStripeEvent {
  action: 'confirm' | 'processing' | 'failed' | 'cancelled' | 'ignore';
  bookingId?: string;
  providerCheckoutId?: string;
  providerPaymentId?: string;
  amountMinor?: number;
  currency?: string;
  failureMessage?: string;
}

export function normalizeStripeEvent(eventInput: unknown): { event: z.infer<typeof stripeEventSchema>; normalized: NormalizedStripeEvent } {
  const event = stripeEventSchema.parse(eventInput);
  const object = event.data.object;
  if (event.type.startsWith('checkout.session.')) {
    const common = {
      bookingId: bookingId(object),
      providerCheckoutId: stringValue(object, 'id'),
      providerPaymentId: objectId(object.payment_intent),
      amountMinor: integerValue(object, 'amount_total'),
      currency: stringValue(object, 'currency')?.toUpperCase()
    };
    if (event.type === 'checkout.session.completed') {
      return { event, normalized: { ...common, action: object.payment_status === 'paid' ? 'confirm' : 'processing' } };
    }
    if (event.type === 'checkout.session.async_payment_succeeded') {
      return { event, normalized: { ...common, action: 'confirm' } };
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      return { event, normalized: { ...common, action: 'failed', failureMessage: 'Stripe asynchronous payment failed.' } };
    }
    if (event.type === 'checkout.session.expired') {
      return { event, normalized: { ...common, action: 'cancelled', failureMessage: 'Stripe Checkout session expired.' } };
    }
  }
  if (event.type.startsWith('payment_intent.')) {
    const lastPaymentError = object.last_payment_error;
    const failureMessage = typeof lastPaymentError === 'object' && lastPaymentError !== null
      ? stringValue(lastPaymentError as Record<string, unknown>, 'message')
      : undefined;
    const common = {
      bookingId: bookingId(object),
      providerPaymentId: stringValue(object, 'id'),
      amountMinor: integerValue(object, 'amount_received', 'amount'),
      currency: stringValue(object, 'currency')?.toUpperCase()
    };
    if (event.type === 'payment_intent.succeeded') return { event, normalized: { ...common, action: 'confirm' } };
    if (event.type === 'payment_intent.processing') return { event, normalized: { ...common, action: 'processing' } };
    if (event.type === 'payment_intent.payment_failed') {
      return { event, normalized: { ...common, action: 'failed', failureMessage: failureMessage ?? 'Stripe payment failed.' } };
    }
  }
  return { event, normalized: { action: 'ignore' } };
}

export async function processStripeEvent(payload: unknown): Promise<{ bookingId?: string; action: NormalizedStripeEvent['action'] }> {
  const { event, normalized } = normalizeStripeEvent(payload);
  if (normalized.action === 'ignore') return { action: 'ignore' };
  if (normalized.action === 'confirm') {
    if (normalized.amountMinor === undefined || !normalized.currency) {
      throw new Error(`Stripe ${event.type} is missing amount or currency.`);
    }
    const result = await confirmStripePayment({
      bookingId: normalized.bookingId,
      providerCheckoutId: normalized.providerCheckoutId,
      providerPaymentId: normalized.providerPaymentId,
      amountMinor: normalized.amountMinor,
      currency: normalized.currency,
      externalEventId: event.id,
      eventType: event.type
    });
    return { bookingId: result.bookingId, action: 'confirm' };
  }
  const result = await updateStripePaymentState({
    bookingId: normalized.bookingId,
    providerCheckoutId: normalized.providerCheckoutId,
    providerPaymentId: normalized.providerPaymentId,
    externalEventId: event.id,
    eventType: event.type,
    outcome: normalized.action,
    failureMessage: normalized.failureMessage
  });
  return { bookingId: result.bookingId, action: normalized.action };
}
