import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeSignatureError, verifyStripeWebhookSignature } from '../../src/modules/integrations/payment-providers/stripe/stripe-signature.js';

describe('Stripe webhook signatures', () => {
  it('accepts a v1 signature over the exact raw request body', () => {
    const rawBody = '{"id":"evt_1","type":"checkout.session.completed"}';
    const timestamp = 1_800_000_000;
    const secret = 'whsec_example';
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(() => verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret,
      nowSeconds: timestamp
    })).not.toThrow();
  });

  it('rejects tampered and stale requests', () => {
    const timestamp = 1_800_000_000;
    const secret = 'whsec_example';
    const signature = createHmac('sha256', secret).update(`${timestamp}.original`).digest('hex');
    expect(() => verifyStripeWebhookSignature({
      rawBody: 'tampered', signatureHeader: `t=${timestamp},v1=${signature}`, secret, nowSeconds: timestamp
    })).toThrow(StripeSignatureError);
    expect(() => verifyStripeWebhookSignature({
      rawBody: 'original', signatureHeader: `t=${timestamp},v1=${signature}`, secret,
      nowSeconds: timestamp + 301, toleranceSeconds: 300
    })).toThrow(/tolerance/i);
  });
});
