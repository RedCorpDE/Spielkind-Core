import type { PaymentProvider, PaymentProviderType } from './payment-provider.js';
import { stripePaymentProvider } from '../integrations/payment-providers/stripe/stripe-payment-provider.js';

class PaymentProviderRegistry {
  private readonly providers = new Map<PaymentProviderType, PaymentProvider>([['stripe', stripePaymentProvider]]);

  get(provider: PaymentProviderType): PaymentProvider {
    const resolved = this.providers.get(provider);
    if (!resolved) throw new Error(`Payment provider ${provider} is not configured for checkout operations.`);
    return resolved;
  }
}

export const paymentProviderRegistry = new PaymentProviderRegistry();
