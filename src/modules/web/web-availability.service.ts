import { pool } from '../../db/pool.js';
import { bookingProviderRegistry } from '../bookings/booking-provider.js';
import { getCatalogProduct, getExternalVariantReference } from '../catalog/catalog.repository.js';
import { getAvailabilitySummary } from '../resources/availability.service.js';
import { createAvailabilityToken } from './availability-token.js';

function endAfterTwoHours(startsAt: string): string {
  return new Date(new Date(startsAt).getTime() + 2 * 60 * 60_000).toISOString();
}

export async function listWebAvailability(input: {
  productId: string; locationId: string; variantId?: string; date?: string; from?: string; to?: string; quantity: number;
}) {
  const product = await getCatalogProduct(input.productId);
  if (!product) return null;
  const queryStart = input.from ?? `${input.date}T00:00:00.000Z`;
  const queryEnd = input.to ?? `${input.date}T23:59:59.999Z`;
  if (product.bookingProvider === 'regiondo') {
    if (!input.variantId) return [];
    const externalVariantId = await getExternalVariantReference(input.variantId);
    if (!externalVariantId) return [];
    const provider = bookingProviderRegistry.get('regiondo');
    const slots = await provider.getAvailability?.({
      externalVariantId, start: queryStart, end: queryEnd, quantity: input.quantity
    }) ?? [];
    return slots.filter((slot) => slot.available).map((slot) => {
      const startsAt = new Date(slot.startsAt).toISOString();
      const endsAt = endAfterTwoHours(startsAt);
      return {
        availabilityId: createAvailabilityToken({
          locationId: input.locationId, productId: input.productId, variantId: input.variantId ?? null,
          startsAt, endsAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        }),
        startsAt, endsAt, remaining: slot.remaining
      };
    });
  }

  const rules = await pool.query<{ starts_at: string; ends_at: string }>(
    `SELECT
       CASE WHEN starts_at IS NOT NULL THEN starts_at
         ELSE ($3::date + local_start_time)::timestamp AT TIME ZONE timezone END AS starts_at,
       CASE WHEN ends_at IS NOT NULL THEN ends_at
         ELSE ($3::date + local_end_time)::timestamp AT TIME ZONE timezone END AS ends_at
     FROM availability_rules
     WHERE is_active = true AND product_id = $1
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
  for (const rule of rules.rows) {
    const startsAt = new Date(rule.starts_at).toISOString();
    const endsAt = new Date(rule.ends_at).toISOString();
    const summary = await getAvailabilitySummary({
      product_id: input.productId, location_id: input.locationId,
      dt_from: startsAt, dt_to: endsAt, guest_count: input.quantity
    });
    if (!summary.available) continue;
    slots.push({
      availabilityId: createAvailabilityToken({
        locationId: input.locationId, productId: input.productId, variantId: input.variantId ?? null,
        startsAt, endsAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
      }),
      startsAt, endsAt, remaining: summary.maxBookableQuantity
    });
  }
  return slots;
}
