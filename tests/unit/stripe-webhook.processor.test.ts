import { describe, expect, it } from 'vitest';
import { normalizeStripeEvent } from '../../src/modules/integrations/payment-providers/stripe/stripe-webhook.processor.js';

const bookingId = '2a9d7a07-dc3b-4855-8c0e-9f94c6288df7';

describe('Stripe webhook normalization', () => {
  it('confirms only paid Checkout completion events', () => {
    const paid = normalizeStripeEvent({
      id: 'evt_paid', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', client_reference_id: bookingId, payment_intent: 'pi_1', payment_status: 'paid', amount_total: 2500, currency: 'eur' } }
    });
    expect(paid.normalized).toMatchObject({
      action: 'confirm', bookingId, providerCheckoutId: 'cs_1', providerPaymentId: 'pi_1', amountMinor: 2500, currency: 'EUR'
    });

    const unpaid = normalizeStripeEvent({
      id: 'evt_unpaid', type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', client_reference_id: bookingId, payment_status: 'unpaid', amount_total: 2500, currency: 'eur' } }
    });
    expect(unpaid.normalized.action).toBe('processing');
  });

  it('maps asynchronous failure and expiry without confirming', () => {
    expect(normalizeStripeEvent({
      id: 'evt_failed', type: 'checkout.session.async_payment_failed',
      data: { object: { id: 'cs_1', metadata: { booking_id: bookingId } } }
    }).normalized.action).toBe('failed');
    expect(normalizeStripeEvent({
      id: 'evt_expired', type: 'checkout.session.expired',
      data: { object: { id: 'cs_1', metadata: { booking_id: bookingId } } }
    }).normalized.action).toBe('cancelled');
  });
});
