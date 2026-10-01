import { pool } from '../../db/pool.js';
import { buildBookingConfiguration } from '../bookings/booking-configuration.service.js';
import type { BookingOffering, OfferingBookingRules } from '../bookings/booking-intent.js';

interface ProductRow {
  product_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  booking_provider: 'core' | 'regiondo';
  price_minor: string | number;
  currency: string;
  vat_basis_points: number;
  variants: unknown;
}

interface ProductOfferingRow extends ProductRow {
  product_offering_id: string;
  location_id: string;
  location_name: string;
  enabled: boolean;
  options: unknown;
  offering_booking_provider: 'core' | 'regiondo';
  time_selection_mode: OfferingBookingRules['timeSelectionMode'];
  timezone: string;
  fixed_start_time: string | null;
  fixed_end_time: string | null;
  earliest_start_time: string | null;
  latest_start_time: string | null;
  start_interval_minutes: number;
  min_participants: number;
  max_participants: number;
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
  duration_step_minutes: number | null;
  default_duration_minutes: number | null;
  allowed_duration_minutes: number[] | null;
  min_advance_minutes: number;
  max_advance_days: number | null;
  same_day_booking_allowed: boolean;
  pricing_mode: OfferingBookingRules['pricingMode'];
  date_range_billing_unit: OfferingBookingRules['dateRangeBillingUnit'];
}

interface CatalogOption {
  id: string;
  variantId: string | null;
  title: string;
  values: Array<{ value: string; label: string }>;
  priceDelta: { amount: number; currency: string };
  durationDeltaMinutes: number;
}

function optionValue(value: unknown): { value: string; label: string } | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return text ? { value: text, label: text } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const labelCandidate = record.label ?? record.title ?? record.name ?? record.value ?? record.id;
  const valueCandidate = record.id ?? record.value ?? record.option_value_id ?? labelCandidate;
  const label = typeof labelCandidate === 'string' || typeof labelCandidate === 'number'
    ? String(labelCandidate).trim()
    : '';
  const normalizedValue = typeof valueCandidate === 'string' || typeof valueCandidate === 'number'
    ? String(valueCandidate).trim()
    : '';
  return label && normalizedValue ? { value: normalizedValue, label } : null;
}

function mapOptions(value: unknown): CatalogOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.title !== 'string') return [];
    const rawValues = Array.isArray(record.values) ? record.values : [];
    const values = rawValues.flatMap((candidate) => {
      const normalized = optionValue(candidate);
      return normalized ? [normalized] : [];
    });
    const price = record.priceDelta as Record<string, unknown> | undefined;
    return [{
      id: record.id,
      variantId: typeof record.variantId === 'string' ? record.variantId : null,
      title: record.title,
      values,
      priceDelta: {
        amount: Number(price?.amount ?? 0),
        currency: typeof price?.currency === 'string' ? price.currency : 'EUR'
      },
      durationDeltaMinutes: Number(record.durationDeltaMinutes ?? 0)
    }];
  });
}

function mapProduct(row: ProductRow) {
  return {
    id: row.product_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    bookingProvider: row.booking_provider,
    price: { amount: Number(row.price_minor), currency: row.currency },
    vatBasisPoints: row.vat_basis_points,
    variants: Array.isArray(row.variants) ? row.variants : []
  };
}

function mapProductOffering(row: ProductOfferingRow) {
  const product = mapProduct(row);
  product.bookingProvider = row.offering_booking_provider;
  const variants = product.variants as Array<{
    id: string; title: string | null; price: { amount: number; currency: string }; durationMinutes?: number | null;
    active?: boolean; scheduleRule?: { enabled: boolean; allowedWeekdays: number[] | null; localStartTime: string | null; localEndTime: string | null };
  }>;
  const options = mapOptions(row.options);
  const rules = mapOfferingRules(row);

  return {
    ...product,
    offering: {
      id: row.product_offering_id,
      locationId: row.location_id,
      locationName: row.location_name,
      active: row.enabled,
      priceFrom: product.price
    },
    bookingConfiguration: buildBookingConfiguration({ rules, variants, options })
  };
}

function selectProductFields(providerExpression = 'product.booking_provider') {
  return `SELECT
  product.product_id, product.title, product.description, product.image_url,
  ${providerExpression} AS booking_provider, product.price_minor, product.currency, product.vat_basis_points,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', variant.variant_id,
      'title', variant.title,
      'price', jsonb_build_object('amount', variant.price_minor, 'currency', variant.currency),
      'durationMinutes', variant.duration_minutes,
      'active', variant.is_active,
      'scheduleRule', jsonb_build_object(
        'enabled', variant.schedule_rule_enabled,
        'allowedWeekdays', variant.allowed_weekdays,
        'localStartTime', to_char(variant.local_start_time, 'HH24:MI'),
        'localEndTime', to_char(variant.local_end_time, 'HH24:MI')
      )
    ) ORDER BY variant.title NULLS LAST)
    FROM product_variants variant
    WHERE variant.product_id = product.product_id
      AND (
        (${providerExpression} = 'regiondo' AND variant.regiondo_variant_id IS NOT NULL)
        OR (${providerExpression} = 'core' AND variant.regiondo_variant_id IS NULL)
      )
  ), '[]'::jsonb) AS variants`;
}

const selectProducts = `${selectProductFields()}
FROM products product`;

export async function listCatalogProducts(locationId?: string) {
  const result = locationId
    ? await pool.query<ProductRow>(
        `${selectProductFields('offering.booking_provider')}
         FROM products product
         INNER JOIN location_products offering
           ON offering.product_id = product.product_id
          AND offering.location_id = $1
          AND offering.enabled = true
         ORDER BY product.title`,
        [locationId]
      )
    : await pool.query<ProductRow>(`${selectProducts} ORDER BY product.title`, []);
  return result.rows.map(mapProduct);
}

export async function getCatalogProduct(productId: string) {
  const result = await pool.query<ProductRow>(`${selectProducts} WHERE product.product_id = $1 LIMIT 1`, [productId]);
  return result.rowCount ? mapProduct(result.rows[0]) : null;
}

export async function getCatalogProductOffering(productId: string, locationId: string) {
  const result = await pool.query<ProductOfferingRow>(
    `${selectProductFields('offering.booking_provider')},
       offering.product_offering_id, offering.location_id, location.title AS location_name, offering.enabled,
       offering.booking_provider AS offering_booking_provider,
       offering.time_selection_mode, offering.timezone, offering.fixed_start_time, offering.fixed_end_time,
       offering.earliest_start_time, offering.latest_start_time, offering.start_interval_minutes,
       offering.min_participants, offering.max_participants,
       offering.min_duration_minutes, offering.max_duration_minutes,
       offering.duration_step_minutes, offering.default_duration_minutes,
       offering.allowed_duration_minutes, offering.min_advance_minutes,
       offering.max_advance_days, offering.same_day_booking_allowed,
       offering.pricing_mode, offering.date_range_billing_unit,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', option_record.option_id,
           'variantId', option_record.variant_id,
           'title', COALESCE(option_record.title, 'Option'),
           'values', COALESCE(option_record.values_json, '[]'::jsonb),
           'priceDelta', jsonb_build_object('amount', option_record.price_delta_minor, 'currency', option_record.currency),
           'durationDeltaMinutes', option_record.duration_delta_minutes
         ) ORDER BY option_record.title NULLS LAST)
         FROM product_options option_record
         WHERE option_record.product_id = product.product_id
           AND (
             (offering.booking_provider = 'regiondo' AND option_record.regiondo_option_id IS NOT NULL)
             OR (offering.booking_provider = 'core' AND option_record.regiondo_option_id IS NULL)
           )
       ), '[]'::jsonb) AS options
     FROM products product
     INNER JOIN location_products offering
       ON offering.product_id = product.product_id
      AND offering.location_id = $2
      AND offering.enabled = true
     INNER JOIN locations location ON location.location_id = offering.location_id
     WHERE product.product_id = $1
     LIMIT 1`,
    [productId, locationId]
  );
  return result.rowCount ? mapProductOffering(result.rows[0]) : null;
}

function mapOfferingRules(row: Pick<ProductOfferingRow,
  'time_selection_mode' | 'timezone' | 'fixed_start_time' | 'fixed_end_time'
  | 'earliest_start_time' | 'latest_start_time' | 'start_interval_minutes' | 'min_participants' | 'max_participants'
  | 'min_duration_minutes' | 'max_duration_minutes' | 'duration_step_minutes'
  | 'default_duration_minutes' | 'allowed_duration_minutes' | 'min_advance_minutes'
  | 'max_advance_days' | 'same_day_booking_allowed' | 'pricing_mode' | 'date_range_billing_unit'>): OfferingBookingRules {
  return {
    timeSelectionMode: row.time_selection_mode ?? 'start_end',
    timezone: row.timezone ?? 'Europe/Berlin',
    fixedStartTime: row.fixed_start_time?.slice(0, 5) ?? null,
    fixedEndTime: row.fixed_end_time?.slice(0, 5) ?? null,
    earliestStartTime: row.earliest_start_time?.slice(0, 5) ?? null,
    latestStartTime: row.latest_start_time?.slice(0, 5) ?? null,
    startIntervalMinutes: row.start_interval_minutes ?? 30,
    minParticipants: row.min_participants ?? 1,
    maxParticipants: row.max_participants ?? 100,
    minDurationMinutes: row.min_duration_minutes ?? null,
    maxDurationMinutes: row.max_duration_minutes ?? null,
    durationStepMinutes: row.duration_step_minutes ?? null,
    defaultDurationMinutes: row.default_duration_minutes ?? null,
    allowedDurationMinutes: row.allowed_duration_minutes ?? [],
    minAdvanceMinutes: row.min_advance_minutes ?? 0,
    maxAdvanceDays: row.max_advance_days ?? null,
    sameDayBookingAllowed: row.same_day_booking_allowed ?? true,
    pricingMode: row.pricing_mode ?? 'per_quantity',
    dateRangeBillingUnit: row.date_range_billing_unit ?? 'nights'
  };
}

export async function getBookingOffering(offeringId: string): Promise<BookingOffering | null> {
  const result = await pool.query<ProductOfferingRow>(
    `SELECT offering.product_offering_id, offering.location_id, offering.product_id,
            offering.enabled, offering.booking_provider AS offering_booking_provider,
            offering.time_selection_mode, offering.timezone, offering.fixed_start_time, offering.fixed_end_time,
            offering.earliest_start_time, offering.latest_start_time, offering.start_interval_minutes,
            offering.min_participants, offering.max_participants,
            offering.min_duration_minutes, offering.max_duration_minutes,
            offering.duration_step_minutes, offering.default_duration_minutes,
            offering.allowed_duration_minutes, offering.min_advance_minutes,
            offering.max_advance_days, offering.same_day_booking_allowed
            , offering.pricing_mode, offering.date_range_billing_unit
     FROM location_products offering
     WHERE offering.product_offering_id = $1
     LIMIT 1`,
    [offeringId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.product_offering_id,
    locationId: row.location_id,
    productId: row.product_id,
    active: row.enabled,
    bookingProvider: row.offering_booking_provider,
    rules: mapOfferingRules(row)
  };
}

export async function getVariantDurationMinutes(variantId?: string): Promise<number | null> {
  if (!variantId) return null;
  const result = await pool.query<{ duration_minutes: number | null }>(
    `SELECT duration_minutes FROM product_variants WHERE variant_id = $1 LIMIT 1`,
    [variantId]
  );
  return result.rows[0]?.duration_minutes ?? null;
}

export async function getExternalVariantReference(variantId: string): Promise<string | null> {
  const result = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM provider_references
     WHERE provider = 'regiondo' AND entity_type = 'product_variant' AND entity_id = $1 LIMIT 1`,
    [variantId]
  );
  return result.rows[0]?.external_id ?? null;
}

