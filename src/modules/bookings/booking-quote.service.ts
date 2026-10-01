import { randomUUID } from 'node:crypto';
import { bookingProviderRegistry, type NormalizedAvailabilityResult } from './booking-provider.js';
import { durationMinutes, validateBookingRules } from './booking-configuration.service.js';
import { participantCount, type BookingIntent } from './booking-intent.js';
import { getBookingOffering, getVariantDurationMinutes } from '../catalog/catalog.repository.js';
import { pricingService, type PricingQuote } from '../pricing/pricing.service.js';
import { resolveCoreBookingSchedule, type ResolvedBookingSchedule } from './booking-schedule.service.js';
import { getVariantEligibility, type VariantEligibility } from './variant-eligibility.service.js';

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
    durationMinutes: number | null;
  };
  schedule: ResolvedBookingSchedule;
  effectiveDurationMinutes: number | null;
  available: boolean;
  availability: NormalizedAvailabilityResult;
  pricing: {
    mode: PricingQuote['calculation']['mode'];
    unitRate: number;
    quantity: number;
    dateUnits: number;
    subtotalBeforeOptions: number;
    optionsSubtotal: number;
    subtotal: number;
    fees: number;
    taxes: number;
    discount: number;
    total: number;
    currency: string;
  };
  variants: VariantEligibility[];
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
  const coreResolution = offering.bookingProvider === 'core'
    ? await resolveCoreBookingSchedule(intent, offering, context.now, context.overrideBookingRules)
    : null;
  const resolvedIntent = coreResolution?.intent ?? intent;
  const validated = context.overrideBookingRules
    ? { participants: participantCount(resolvedIntent), durationMinutes: durationMinutes(resolvedIntent.startAt, resolvedIntent.endAt) }
    : coreResolution
      ? { participants: participantCount(resolvedIntent), durationMinutes: coreResolution.schedule.durationMinutes }
      : validateBookingRules({
        intent: resolvedIntent,
        rules: offering.rules,
        variantDurationMinutes: variantDuration,
        now: context.now
      });
  const provider = bookingProviderRegistry.get(offering.bookingProvider);
  if (!provider.checkAvailability) throw new Error(`${provider.displayName} availability is unavailable.`);
  const providerAvailability = await provider.checkAvailability({ intent: resolvedIntent, offering });
  const availability = context.overrideAvailability
    ? { ...providerAvailability, available: true }
    : providerAvailability;
  const price = await pricingService.quote({
    productId: resolvedIntent.productId,
    variantId: resolvedIntent.variantId,
    options: (resolvedIntent.options ?? []).map((option) => ({ optionId: option.optionId, value: option.value ?? '' })),
    quantity: validated.participants,
    clientId: context.clientId,
    locationId: resolvedIntent.locationId,
    locationProductId: resolvedIntent.locationProductId,
    discountCode: resolvedIntent.discountCode,
    dateUnits: coreResolution?.schedule.billableDateUnits ?? 1
  });
  const variants = offering.bookingProvider === 'core'
    ? await getVariantEligibility({
        productId: resolvedIntent.productId,
        selectedVariantId: resolvedIntent.variantId,
        startsAt: resolvedIntent.startAt,
        timezone: offering.rules.timezone
      })
    : [];
  const calculation = price.calculation ?? {
    mode: 'per_quantity' as const,
    unitRate: price.items[0]?.unitPriceGross ?? 0,
    quantity: validated.participants,
    dateUnits: coreResolution?.schedule.billableDateUnits ?? 1,
    subtotalBeforeOptions: price.subtotalGross,
    optionsSubtotal: 0
  };
  const expiresAt = new Date((context.now ?? new Date()).getTime() + 15 * 60_000).toISOString();

  return {
    quoteId: randomUUID(),
    configuration: {
      locationId: resolvedIntent.locationId,
      productId: resolvedIntent.productId,
      locationProductId: resolvedIntent.locationProductId,
      variantId: resolvedIntent.variantId ?? null,
      startAt: resolvedIntent.startAt,
      endAt: resolvedIntent.endAt,
      participants: validated.participants,
      options: resolvedIntent.options ?? [],
      durationMinutes: coreResolution
        ? coreResolution.schedule.effectiveDurationMinutes
        : resolvedIntent.durationMinutes ?? null
    },
    schedule: coreResolution?.schedule ?? {
      startsAt: resolvedIntent.startAt,
      endsAt: resolvedIntent.endAt,
      durationMinutes: validated.durationMinutes,
      effectiveDurationMinutes: variantDuration ?? offering.rules.defaultDurationMinutes,
      timezone: offering.rules.timezone
      , billableDateUnits: null
    },
    effectiveDurationMinutes: coreResolution
      ? coreResolution.schedule.effectiveDurationMinutes
      : variantDuration ?? offering.rules.defaultDurationMinutes,
    available: availability.available,
    availability,
    pricing: {
      mode: calculation.mode,
      unitRate: calculation.unitRate,
      quantity: calculation.quantity,
      dateUnits: calculation.dateUnits,
      subtotalBeforeOptions: calculation.subtotalBeforeOptions,
      optionsSubtotal: calculation.optionsSubtotal,
      subtotal: price.subtotalGross,
      fees: 0,
      taxes: price.tax,
      discount: price.discount,
      total: price.total,
      currency: price.currency
    },
    variants,
    expiresAt,
    ...price
  };
}

export const bookingQuoteService = { quote: quoteBookingIntent };

