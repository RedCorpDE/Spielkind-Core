export type PaymentProviderType = 'stripe' | 'regiondo' | 'manual';

export interface PaymentCheckout {
  externalCheckoutId: string;
  redirectUrl: string | null;
  expiresAt: string | null;
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
  retrievePayment(externalPaymentId: string): Promise<{ status: string; amountMinor: number; currency: string }>;
  refund(input: {
    externalPaymentId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ externalRefundId: string; status: string }>;
}

