export type PaymentProviderType = 'stripe' | 'regiondo' | 'manual';

export interface PaymentCheckout {
  externalCheckoutId: string;
  redirectUrl: string | null;
  expiresAt: string | null;
}

export interface PaymentIntentCheckout {
  externalPaymentId: string;
  clientSecret: string;
  status: string;
}

export interface PaymentProvider {
  readonly key: PaymentProviderType;
  createCheckout(input: {
    bookingId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<PaymentCheckout>;
  createPaymentIntent?(input: {
    bookingId: string;
    locationId: string;
    productId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    customerEmail?: string;
  }): Promise<PaymentIntentCheckout>;
  retrievePayment(externalPaymentId: string): Promise<{ status: string; amountMinor: number; currency: string }>;
  refund(input: {
    externalPaymentId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    bookingId?: string;
  }): Promise<{ externalRefundId: string; status: string }>;
}

