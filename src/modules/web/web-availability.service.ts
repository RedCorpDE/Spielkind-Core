import { pool } from '../../db/pool.js';
import { bookingProviderRegistry } from '../bookings/booking-provider.js';
import { getBookingOffering, getCatalogProductOffering, getExternalVariantReference, getVariantDurationMinutes } from '../catalog/catalog.repository.js';
import { getAvailabilitySummary } from '../resources/availability.service.js';
import { createAvailabilityToken } from './availability-token.js';
import { parseRegiondoDateTime } from '../regiondo/regiondo-datetime.js';
import { resolveCoreBookingSchedule } from '../bookings/booking-schedule.service.js';
import type { BookingIntentOption } from '../bookings/booking-intent.js';
import { listCoreStartSlots } from '../bookings/booking-slot.service.js';

function endAfterMinutes(startsAt: string, minutes: number): string {
  return new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
}

export async function listWebAvailability(input: {
  productId: string; locationId: string; variantId?: string; date?: string; from?: string; to?: string;
  startDate?: string; endDate?: string; startTime?: string; endTime?: string;
  durationMinutes?: number; quantity: number; options?: BookingIntentOption[];
}) {
  const product = await getCatalogProductOffering(input.productId, input.locationId);
  if (!product) return null;
  const queryStart = input.from ?? `${input.date}T00:00:00.000Z`;
  const queryEnd = input.to ?? `${input.date}T23:59:59.999Z`;
  const customerStartSlots = product.bookingProvider === 'core'
    && product.bookingConfiguration.timeSelection.startTimeSelection === 'customer'
    && (product.bookingConfiguration.timeSelection.mode === 'fixed_duration'
      || product.bookingConfiguration.timeSelection.mode === 'start_duration')
    && input.startDate && input.startTime;
  if (customerStartSlots) {
    const offering = await getBookingOffering(product.offering.id);
    if (!offering) return null;
    const result = await listCoreStartSlots({
      offering,
      requestedDate: input.startDate,
      requestedTime: input.startTime,
      intent: {
        locationId: input.locationId,
        productId: input.productId,
        locationProductId: product.offering.id,
        variantId: input.variantId,
        startAt: queryStart,
        endAt: queryEnd,
        startDate: input.startDate,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        participants: input.quantity,
        options: input.options ?? []
      }
    });
    return {
      items: result.slots.map((slot) => ({
        availabilityId: createAvailabilityToken({
          locationId: input.locationId, productId: input.productId, locationProductId: product.offering.id,
          variantId: input.variantId ?? null, startsAt: slot.startsAt, endsAt: slot.endsAt,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        }),
        ...slot
      })),
      selectedDate: result.selectedDate,
      effectiveDurationMinutes: result.effectiveDurationMinutes,
      allowedStart: result.allowedStart,
      variants: result.variants,
      fixedStart: result.fixedStart
    };
  }
  const directCoreSelection = product.bookingProvider === 'core' && (
    (product.bookingConfiguration.timeSelection.mode === 'date_range' && input.from && input.to)
    || (product.bookingConfiguration.timeSelection.mode === 'fixed_duration' && input.startDate
      && (input.startTime || product.bookingConfiguration.timeSelection.fixedStartTime))
  );
  if (directCoreSelection) {
    const offering = await getBookingOffering(product.offering.id);
    if (!offering) return null;
    const provider = bookingProviderRegistry.get(offering.bookingProvider);
    const rawIntent = {
      locationId: input.locationId,
      productId: input.productId,
      locationProductId: product.offering.id,
      variantId: input.variantId,
      startAt: queryStart,
      endAt: queryEnd,
      startDate: input.startDate,
      endDate: input.endDate,
      startTime: input.startTime,
      endTime: input.endTime,
      durationMinutes: input.durationMinutes,
      participants: input.quantity,
      options: input.options ?? []
    };
    const resolvedIntent = offering.bookingProvider === 'core'
      ? (await resolveCoreBookingSchedule(rawIntent, offering)).intent
      : rawIntent;
    const result = await provider.checkAvailability?.({
      offering,
      intent: resolvedIntent
    });
    if (!result?.available) return { items: [] };
    return { items: [{
      availabilityId: createAvailabilityToken({
        locationId: input.locationId,
        productId: input.productId,
        locationProductId: product.offering.id,
        variantId: input.variantId ?? null,
        startsAt: resolvedIntent.startAt,
        endsAt: resolvedIntent.endAt,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
      }),
      startsAt: resolvedIntent.startAt,
      endsAt: resolvedIntent.endAt,
      remaining: result.maxBookableQuantity,
      label: 'Selected stay'
    }] };
  }
  if (product.bookingProvider === 'regiondo') {
    if (!input.variantId) return { items: [] };
    const externalVariantId = await getExternalVariantReference(input.variantId);
    if (!externalVariantId) return { items: [] };
    const provider = bookingProviderRegistry.get('regiondo');
    const slots = await provider.getAvailability?.({
      externalVariantId, start: queryStart, end: queryEnd, quantity: input.quantity
    }) ?? [];
    const variantDuration = await getVariantDurationMinutes(input.variantId);
    const configuredDuration = input.durationMinutes ?? product.bookingConfiguration.timeSelection.duration?.defaultMinutes;
    return { items: slots.filter((slot) => slot.available).flatMap((slot) => {
      const normalizedStart = parseRegiondoDateTime(slot.startsAt);
      if (!normalizedStart) return [];
      const startsAt = normalizedStart.toISOString();
      const endsAt = endAfterMinutes(startsAt, variantDuration ?? configuredDuration ?? 120);
      return [{
        availabilityId: createAvailabilityToken({
          locationId: input.locationId, productId: input.productId, locationProductId: product.offering.id,
          variantId: input.variantId ?? null,
          startsAt, endsAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        }),
        startsAt, endsAt, remaining: slot.remaining
      }];
    }) };
  }

  const rules = await pool.query<{ starts_at: string; ends_at: string }>(
    `SELECT
       CASE WHEN starts_at IS NOT NULL THEN starts_at
         ELSE ($3::date + local_start_time)::timestamp AT TIME ZONE timezone END AS starts_at,
       CASE WHEN ends_at IS NOT NULL THEN ends_at
         ELSE ($3::date + local_end_time)::timestamp AT TIME ZONE timezone END AS ends_at
     FROM availability_rules
     WHERE is_active = true AND rule_type <> 'manual_block' AND product_id = $1
       AND (location_id IS NULL OR location_id = $2)
       AND (product_variant_id IS NULL OR product_variant_id = $4)
       AND (weekdays IS NULL OR EXTRACT(ISODOW FROM $3::date)::smallint = ANY(weekdays))
       AND (starts_at IS NULL OR starts_at < $5::timestamptz)
       AND (ends_at IS NULL OR ends_at > $6::timestamptz)
       AND (starts_at IS NOT NULL OR (local_start_time IS NOT NULL AND local_end_time IS NOT NULL))
     ORDER BY starts_at NULLS LAST, local_start_time`,
    [input.productId, input.locationId, input.date, input.variantId ?? null, queryEnd, queryStart]
  );
  const slots = [];
  const offering = await getBookingOffering(product.offering.id);
  if (!offering) return null;
  for (const rule of rules.rows) {
    const startsAt = new Date(rule.starts_at).toISOString();
    const ruleEndsAt = new Date(rule.ends_at).toISOString();
    const resolution = await resolveCoreBookingSchedule({
      locationId: input.locationId,
      productId: input.productId,
      locationProductId: product.offering.id,
      variantId: input.variantId,
      startAt: startsAt,
      endAt: ruleEndsAt,
      durationMinutes: input.durationMinutes,
      participants: input.quantity,
      options: input.options ?? []
    }, offering);
    const endsAt = resolution.schedule.endsAt;
    if (new Date(endsAt) > new Date(ruleEndsAt)) continue;
    const summary = await getAvailabilitySummary({
      product_id: input.productId, product_variant_id: input.variantId, location_id: input.locationId,
      dt_from: startsAt, dt_to: endsAt, guest_count: input.quantity
    });
    if (!summary.available) continue;
    slots.push({
      availabilityId: createAvailabilityToken({
        locationId: input.locationId, productId: input.productId, locationProductId: product.offering.id,
        variantId: input.variantId ?? null,
        startsAt, endsAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
      }),
      startsAt, endsAt, remaining: summary.maxBookableQuantity
    });
  }
  return { items: slots };
}
