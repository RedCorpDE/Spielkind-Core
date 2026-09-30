import { randomUUID } from 'node:crypto';
import { bookingProviderRegistry, type NormalizedAvailabilityResult } from './booking-provider.js';
import { durationMinutes, validateBookingRules } from './booking-configuration.service.js';
import { participantCount, type BookingIntent } from './booking-intent.js';
import { getBookingOffering, getVariantDurationMinutes } from '../catalog/catalog.repository.js';
import { pricingService, type PricingQuote } from '../pricing/pricing.service.js';

export class BookingQuoteError extends Error {
  constructor(readonly code: 'OFFERING_NOT_FOUND' | 'OFFERING_INACTIVE' | 'INVALID_OFFERING_PAIRING', message: string) {
    super(message);
    this.name = 'BookingQuoteError';
  }
}

export interface NormalizedBookingQuote {
  quoteId: string;
  configuration: {
    locationId: string;
    productId: string;
    locationProductId: string;
    variantId: string | null;
    startAt: string;
    endAt: string;
    participants: number;
    options: BookingIntent['options'];
  };
  available: boolean;
  availability: NormalizedAvailabilityResult;
  pricing: {
    subtotal: number;
    fees: number;
    taxes: number;
    discount: number;
    total: number;
    currency: string;
  };
  expiresAt: string;
  // Compatibility projection for consumers of the first Core pricing API.
  items: PricingQuote['items'];
  subtotalNet: number;
  tax: number;
  subtotalGross: number;
  discount: number;
  total: number;
  currency: string;
}

export async function quoteBookingIntent(
  intent: BookingIntent,
  context: { clientId?: string; now?: Date; overrideAvailability?: boolean; overrideBookingRules?: boolean } = {}
): Promise<NormalizedBookingQuote> {
  const offering = await getBookingOffering(intent.locationProductId);
  if (!offering) throw new BookingQuoteError('OFFERING_NOT_FOUND', 'The selected offering was not found.');
  if (!offering.active) throw new BookingQuoteError('OFFERING_INACTIVE', 'The selected offering is inactive.');
  if (offering.locationId !== intent.locationId || offering.productId !== intent.productId) {
    throw new BookingQuoteError('INVALID_OFFERING_PAIRING', 'Product, location, and offering do not match.');
  }

  const variantDuration = await getVariantDurationMinutes(intent.variantId);
  const validated = context.overrideBookingRules
    ? { participants: participantCount(intent), durationMinutes: durationMinutes(intent.startAt, intent.endAt) }
    : validateBookingRules({
        intent,
        rules: offering.rules,
        variantDurationMinutes: variantDuration,
        now: context.now
      });
  const provider = bookingProviderRegistry.get(offering.bookingProvider);
  if (!provider.checkAvailability) throw new Error(`${provider.displayName} availability is unavailable.`);
  const providerAvailability = await provider.checkAvailability({ intent, offering });
  const availability = context.overrideAvailability
    ? { ...providerAvailability, available: true }
    : providerAvailability;
  const price = await pricingService.quote({
    productId: intent.productId,
    variantId: intent.variantId,
    options: (intent.options ?? []).map((option) => ({ optionId: option.optionId, value: option.value ?? '' })),
    quantity: validated.participants,
    clientId: context.clientId,
    locationId: intent.locationId,
    locationProductId: intent.locationProductId,
    discountCode: intent.discountCode
  });
  const expiresAt = new Date((context.now ?? new Date()).getTime() + 15 * 60_000).toISOString();

  return {
    quoteId: randomUUID(),
    configuration: {
      locationId: intent.locationId,
      productId: intent.productId,
      locationProductId: intent.locationProductId,
      variantId: intent.variantId ?? null,
      startAt: intent.startAt,
      endAt: intent.endAt,
      participants: validated.participants,
      options: intent.options ?? []
    },
    available: availability.available,
    availability,
    pricing: {
      subtotal: price.subtotalGross,
      fees: 0,
      taxes: price.tax,
      discount: price.discount,
      total: price.total,
      currency: price.currency
    },
    expiresAt,
    ...price
  };
}

export const bookingQuoteService = { quote: quoteBookingIntent };

