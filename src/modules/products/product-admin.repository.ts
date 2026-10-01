import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import type {
  RegiondoCatalogOptionRowSummaryInput,
  RegiondoCatalogVariationRowSummaryInput,
  RegiondoProductCatalogSummary
} from '../regiondo/regiondo-product-catalog.js';
import { summarizeRegiondoProductCatalogFromRows } from '../regiondo/regiondo-product-catalog.js';
import { BookingRuleValidationError } from '../bookings/booking-configuration.service.js';

export interface AdminProductResourceMapping {
  resourceId: string;
  resourceTitle: string;
  quantity: number;
  scalingMode: 'per_quantity' | 'per_booking';
}

export interface AdminProductOffering {
  offeringId: string;
  productId: string;
  locationId: string;
  locationTitle: string;
  enabled: boolean;
  bookingProvider: 'core' | 'regiondo';
  timeSelectionMode: 'date_range' | 'start_end' | 'start_duration' | 'fixed_duration';
  timezone: string;
  fixedStartTime: string | null;
  fixedEndTime: string | null;
  minParticipants: number;
  maxParticipants: number;
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
  durationStepMinutes: number | null;
  defaultDurationMinutes: number | null;
  allowedDurationMinutes: number[];
  minAdvanceMinutes: number;
  maxAdvanceDays: number | null;
  sameDayBookingAllowed: boolean;
  pricingMode: 'once' | 'per_quantity' | 'per_date_unit' | 'per_date_unit_per_quantity';
  dateRangeBillingUnit: 'nights' | 'calendar_days';
  createdAt: string;
  updatedAt: string;
  resources: AdminProductResourceMapping[];
}

export interface AdminProductOption {
  optionId: string;
  title: string;
  values: string[];
  priceDeltaMinor: number;
  currency: string;
  durationDeltaMinutes: number;
  providerManaged: boolean;
}

export interface AdminProductVariant {
  variantId: string;
  title: string | null;
  priceMinor: number;
  currency: string;
  isDefault: boolean;
  providerManaged: boolean;
  durationOverrideMinutes: number | null;
  active: boolean;
  scheduleRuleEnabled: boolean;
  allowedWeekdays: number[] | null;
  localStartTime: string | null;
  localEndTime: string | null;
  options: AdminProductOption[];
}

export interface AdminProductCoreMigration {
  status: 'not_prepared' | 'prepared';
  variantCount: number;
  optionCount: number;
  preparedAt: string | null;
  policy: 'prepare_once';
}

export interface AdminProduct {
  productId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  baseAmount: number;
  bookingProvider: 'core' | 'regiondo';
  priceMinor: number;
  currency: string;
  vatBasisPoints: number;
  regiondoProductId: string | null;
  regiondoCatalog: RegiondoProductCatalogSummary;
  rawJson: unknown;
  resources: AdminProductResourceMapping[];
  locations: AdminProductOffering[];
  variants: AdminProductVariant[];
  coreMigration: AdminProductCoreMigration | null;
}

export interface CreateAdminProductInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  baseAmount: number;
  currency?: string;
  vatBasisPoints: number;
}

export interface AdminProductVariantInput {
  title: string | null;
  priceMinor: number;
  currency: string;
  durationOverrideMinutes?: number | null;
  active?: boolean;
  scheduleRuleEnabled?: boolean;
  allowedWeekdays?: number[] | null;
  localStartTime?: string | null;
  localEndTime?: string | null;
}

export interface AdminProductOptionInput {
  title: string;
  values: string[];
  priceDeltaMinor: number;
  currency: string;
  durationDeltaMinutes?: number;
}

export type CatalogMutationFailure = 'not_found' | 'provider_managed' | 'in_use' | 'default_exists';

export interface CoreProviderSwitchValidation {
  valid: boolean;
  issues: string[];
}

interface ProductRow {
  product_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  base_amount: string | number;
  booking_provider: 'core' | 'regiondo';
  price_minor: string | number;
  currency: string;
  vat_basis_points: number;
  regiondo_product_id: string | null;
  regiondo_raw: unknown;
  core_migration_prepared_at: string | null;
  resources: AdminProductResourceMapping[] | null;
  locations: AdminProductOffering[] | null;
  variants: AdminProductVariant[] | null;
}

interface ProductVariantRow {
  price: string | number | null;
  regiondo_product_id: string;
  regiondo_raw: unknown;
  regiondo_variant_id: string;
  title: string | null;
}

interface ProductOptionRow {
  regiondo_option_id: string;
  regiondo_product_id: string;
  regiondo_raw: unknown;
  regiondo_variant_id: string | null;
  title: string | null;
  values_json: unknown;
}

const EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY: RegiondoProductCatalogSummary = {
  options: [],
  variations: []
};

function mapProductRow(row: ProductRow, regiondoCatalog: RegiondoProductCatalogSummary): AdminProduct {
  const variants = row.variants ?? [];
  const preparedVariants = variants.filter((variant) => !variant.providerManaged);
  return {
    productId: row.product_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    baseAmount: Number(row.base_amount),
    bookingProvider: row.booking_provider,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    vatBasisPoints: row.vat_basis_points,
    regiondoProductId: row.regiondo_product_id,
    regiondoCatalog,
    rawJson: row.regiondo_raw,
    resources: row.resources ?? [],
    locations: row.locations ?? [],
    variants,
    coreMigration:
      row.booking_provider === 'regiondo'
        ? {
            status: preparedVariants.length ? 'prepared' : 'not_prepared',
            variantCount: preparedVariants.length,
            optionCount: preparedVariants.reduce((count, variant) => count + variant.options.length, 0),
            preparedAt: row.core_migration_prepared_at,
            policy: 'prepare_once'
          }
        : null
  };
}

const productSelect = `SELECT
   p.product_id,
   p.title,
   p.description,
   p.image_url,
   p.base_amount,
   p.booking_provider,
   p.price_minor,
   p.currency,
   p.vat_basis_points,
   p.regiondo_product_id,
   p.regiondo_raw,
   (
     SELECT reference.metadata->>'coreMigrationPreparedAt'
     FROM provider_references reference
     WHERE reference.provider = 'regiondo'
       AND reference.entity_type = 'product'
       AND reference.entity_id = p.product_id
     LIMIT 1
   ) AS core_migration_prepared_at,
   COALESCE(
     (
       SELECT jsonb_agg(
         jsonb_build_object(
           'offeringId', lp.product_offering_id,
           'productId', lp.product_id,
           'locationId', lp.location_id,
           'locationTitle', location.title,
           'enabled', lp.enabled,
           'bookingProvider', lp.booking_provider,
           'timeSelectionMode', lp.time_selection_mode,
           'timezone', lp.timezone,
           'fixedStartTime', to_char(lp.fixed_start_time, 'HH24:MI'),
           'fixedEndTime', to_char(lp.fixed_end_time, 'HH24:MI'),
           'earliestStartTime', to_char(lp.earliest_start_time, 'HH24:MI'),
           'latestStartTime', to_char(lp.latest_start_time, 'HH24:MI'),
           'startIntervalMinutes', lp.start_interval_minutes,
           'minParticipants', lp.min_participants,
           'maxParticipants', lp.max_participants,
           'minDurationMinutes', lp.min_duration_minutes,
           'maxDurationMinutes', lp.max_duration_minutes,
           'durationStepMinutes', lp.duration_step_minutes,
           'defaultDurationMinutes', lp.default_duration_minutes,
           'allowedDurationMinutes', COALESCE(lp.allowed_duration_minutes, ARRAY[]::integer[]),
           'minAdvanceMinutes', lp.min_advance_minutes,
           'maxAdvanceDays', lp.max_advance_days,
           'sameDayBookingAllowed', lp.same_day_booking_allowed,
           'pricingMode', lp.pricing_mode,
           'dateRangeBillingUnit', lp.date_range_billing_unit,
           'createdAt', lp.created_at,
           'updatedAt', lp.updated_at
           , 'resources', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'resourceId', offering_resource.resource_id,
               'resourceTitle', resource.title,
               'quantity', offering_resource.quantity,
               'scalingMode', offering_resource.scaling_mode
             ) ORDER BY resource.title ASC)
             FROM product_offering_resources offering_resource
             INNER JOIN resources resource ON resource.resource_id = offering_resource.resource_id
             WHERE offering_resource.product_offering_id = lp.product_offering_id
           ), '[]'::jsonb)
         ) ORDER BY location.title ASC
       )
       FROM location_products lp
       INNER JOIN locations location ON location.location_id = lp.location_id
       WHERE lp.product_id = p.product_id
     ),
     '[]'::jsonb
   ) AS locations,
   COALESCE(
     (
       SELECT jsonb_agg(
         jsonb_build_object(
           'variantId', variant.variant_id,
           'title', variant.title,
           'priceMinor', COALESCE(variant.price_minor, ROUND(variant.price * 100)::bigint, 0),
           'currency', variant.currency,
           'isDefault', variant.regiondo_variant_id IS NULL AND variant.title IS NULL,
           'providerManaged', variant.regiondo_variant_id IS NOT NULL,
           'durationOverrideMinutes', variant.duration_minutes,
           'active', variant.is_active,
           'scheduleRuleEnabled', variant.schedule_rule_enabled,
           'allowedWeekdays', variant.allowed_weekdays,
           'localStartTime', to_char(variant.local_start_time, 'HH24:MI'),
           'localEndTime', to_char(variant.local_end_time, 'HH24:MI'),
           'options', COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'optionId', option_record.option_id,
                   'title', COALESCE(option_record.title, 'Option'),
                   'values', COALESCE(option_record.values_json, '[]'::jsonb),
                   'priceDeltaMinor', option_record.price_delta_minor,
                   'currency', option_record.currency,
                   'providerManaged', option_record.regiondo_option_id IS NOT NULL,
                   'durationDeltaMinutes', option_record.duration_delta_minutes
                 ) ORDER BY option_record.created_at ASC, option_record.option_id ASC
               )
               FROM product_options option_record
               WHERE option_record.variant_id = variant.variant_id
             ),
             '[]'::jsonb
           )
         ) ORDER BY variant.created_at ASC, variant.variant_id ASC
       )
       FROM product_variants variant
       WHERE variant.product_id = p.product_id
     ),
     '[]'::jsonb
   ) AS variants,
   COALESCE(
     jsonb_agg(
       DISTINCT jsonb_build_object(
         'resourceId', r.resource_id,
         'resourceTitle', r.title,
         'quantity', pr.quantity,
         'scalingMode', 'per_quantity'
       )
     ) FILTER (WHERE r.resource_id IS NOT NULL),
     '[]'::jsonb
   ) AS resources
 FROM products p
 LEFT JOIN product_resources pr ON pr.product_id = p.product_id
 LEFT JOIN resources r ON r.resource_id = pr.resource_id`;

async function loadRegiondoCatalogByProductId(
  regiondoProductIds: string[]
): Promise<Map<string, RegiondoProductCatalogSummary>> {
  if (!regiondoProductIds.length) {
    return new Map();
  }

  const [variationResult, optionResult] = await Promise.all([
    pool.query<ProductVariantRow>(
      `SELECT regiondo_product_id, regiondo_variant_id, title, price, regiondo_raw
       FROM product_variants
       WHERE regiondo_product_id = ANY($1::text[])
       ORDER BY regiondo_product_id ASC, regiondo_variant_id ASC`,
      [regiondoProductIds]
    ),
    pool.query<ProductOptionRow>(
      `SELECT regiondo_product_id, regiondo_variant_id, regiondo_option_id, title, values_json, regiondo_raw
       FROM product_options
       WHERE regiondo_product_id = ANY($1::text[])
       ORDER BY regiondo_product_id ASC, regiondo_variant_id ASC NULLS LAST, regiondo_option_id ASC`,
      [regiondoProductIds]
    )
  ]);

  const variationsByProductId = new Map<string, RegiondoCatalogVariationRowSummaryInput[]>();
  const optionsByProductId = new Map<string, RegiondoCatalogOptionRowSummaryInput[]>();

  variationResult.rows.forEach((row) => {
    const variations = variationsByProductId.get(row.regiondo_product_id) ?? [];
    variations.push({
      price:
        row.price === null || row.price === undefined
          ? null
          : typeof row.price === 'number'
            ? row.price
            : Number(row.price),
      rawJson: row.regiondo_raw,
      regiondoVariantId: row.regiondo_variant_id,
      title: row.title
    });
    variationsByProductId.set(row.regiondo_product_id, variations);
  });

  optionResult.rows.forEach((row) => {
    const options = optionsByProductId.get(row.regiondo_product_id) ?? [];
    options.push({
      rawJson: row.regiondo_raw,
      regiondoOptionId: row.regiondo_option_id,
      regiondoVariantId: row.regiondo_variant_id,
      title: row.title,
      valuesJson: row.values_json
    });
    optionsByProductId.set(row.regiondo_product_id, options);
  });

  return regiondoProductIds.reduce((result, regiondoProductId) => {
    result.set(
      regiondoProductId,
      summarizeRegiondoProductCatalogFromRows({
        options: optionsByProductId.get(regiondoProductId) ?? [],
        variations: variationsByProductId.get(regiondoProductId) ?? []
      })
    );
    return result;
  }, new Map<string, RegiondoProductCatalogSummary>());
}

async function mapAdminProducts(rows: ProductRow[]): Promise<AdminProduct[]> {
  const regiondoCatalogByProductId = await loadRegiondoCatalogByProductId(
    rows
      .map((row) => row.regiondo_product_id)
      .filter((regiondoProductId): regiondoProductId is string => Boolean(regiondoProductId))
  );

  return rows.map((row) =>
    mapProductRow(
      row,
      row.regiondo_product_id
        ? (regiondoCatalogByProductId.get(row.regiondo_product_id) ?? EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY)
        : EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY
    )
  );
}

export async function listAdminProducts(): Promise<AdminProduct[]> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     GROUP BY p.product_id
     ORDER BY p.title ASC`
  );

  return mapAdminProducts(result.rows);
}

export async function createAdminProduct(input: CreateAdminProductInput): Promise<AdminProduct> {
  const result = await pool.query<{ product_id: string }>(
    `INSERT INTO products (
       title,
       description,
       image_url,
       base_amount,
       booking_provider,
       price_minor,
       currency,
       vat_basis_points,
       regiondo_product_id,
       regiondo_raw
     ) VALUES ($1, $2, $3, $4::numeric / 100, 'core', $4, $5, $6, NULL, NULL)
     RETURNING product_id`,
    [
      input.title.trim(),
      input.description?.trim() || null,
      input.imageUrl?.trim() || null,
      input.baseAmount,
      (input.currency ?? 'EUR').trim().toUpperCase(),
      input.vatBasisPoints
    ]
  );

  const productId = result.rows[0]?.product_id;
  const product = productId ? await getAdminProduct(productId) : null;
  if (!product) {
    throw new Error('Created product could not be loaded.');
  }

  return product;
}

export async function cloneAdminProduct(productId: string): Promise<AdminProduct | null> {
  const clonedProductId = await withTransaction(async (client) => {
    const sourceResult = await client.query<{
      title: string;
      description: string | null;
      image_url: string | null;
      base_amount: string | number;
      price_minor: string | number;
      currency: string;
      vat_basis_points: number;
      cancellation_policy_id: string | null;
    }>(
      `SELECT title, description, image_url, base_amount, price_minor, currency,
              vat_basis_points, cancellation_policy_id
       FROM products
       WHERE product_id = $1
       FOR SHARE`,
      [productId]
    );
    const source = sourceResult.rows[0];
    if (!source) return null;

    const productResult = await client.query<{ product_id: string }>(
      `INSERT INTO products (
         title, description, image_url, base_amount, booking_provider,
         price_minor, currency, vat_basis_points, regiondo_product_id,
         regiondo_raw, cancellation_policy_id
       ) VALUES ($1, $2, $3, $4, 'core', $5, $6, $7, NULL, NULL, $8)
       RETURNING product_id`,
      [
        `${source.title} (Copy)`,
        source.description,
        source.image_url,
        source.base_amount,
        source.price_minor,
        source.currency,
        source.vat_basis_points,
        source.cancellation_policy_id
      ]
    );
    const cloneId = productResult.rows[0]?.product_id;
    if (!cloneId) throw new Error('Cloned product could not be created.');

    const variantsResult = await client.query<{
      variant_id: string;
      title: string | null;
      price: string | number;
      price_minor: string | number | null;
      currency: string;
      duration_minutes: number | null;
      cancellation_policy_id: string | null;
      is_active: boolean;
      schedule_rule_enabled: boolean;
      allowed_weekdays: number[] | null;
      local_start_time: string | null;
      local_end_time: string | null;
    }>(
      `SELECT variant_id, title, price, price_minor, currency, duration_minutes,
              cancellation_policy_id, is_active, schedule_rule_enabled,
              allowed_weekdays, local_start_time, local_end_time
       FROM product_variants
       WHERE product_id = $1
       ORDER BY created_at ASC, variant_id ASC`,
      [productId]
    );
    const variantIds = new Map<string, string>();
    let hasDefaultVariant = false;
    for (const [index, variant] of variantsResult.rows.entries()) {
      const variantTitle = variant.title === null && hasDefaultVariant ? `Variant ${index + 1}` : variant.title;
      if (variantTitle === null) hasDefaultVariant = true;
      const clonedVariant = await client.query<{ variant_id: string }>(
        `INSERT INTO product_variants (
           product_id, title, price, price_minor, currency,
           regiondo_variant_id, regiondo_product_id, regiondo_raw,
           duration_minutes, cancellation_policy_id, is_active,
           schedule_rule_enabled, allowed_weekdays, local_start_time, local_end_time
         ) VALUES (
           $1, $2, $3, $4, $5, NULL, NULL, NULL, $6, $7, $8, $9, $10, $11, $12
         )
         RETURNING variant_id`,
        [
          cloneId,
          variantTitle,
          variant.price,
          variant.price_minor ?? Math.round(Number(variant.price) * 100),
          variant.currency,
          variant.duration_minutes,
          variant.cancellation_policy_id,
          variant.is_active,
          variant.schedule_rule_enabled,
          variant.allowed_weekdays,
          variant.local_start_time,
          variant.local_end_time
        ]
      );
      const clonedVariantId = clonedVariant.rows[0]?.variant_id;
      if (!clonedVariantId) throw new Error('Cloned product variant could not be created.');
      variantIds.set(variant.variant_id, clonedVariantId);
      await client.query(
        `INSERT INTO product_options (
           product_id, variant_id, title, values_json, price_delta_minor,
           currency, regiondo_option_id, regiondo_product_id,
           regiondo_variant_id, regiondo_raw, duration_delta_minutes
         )
         SELECT $1, $2, title, values_json, price_delta_minor, currency,
                NULL, NULL, NULL, NULL, duration_delta_minutes
         FROM product_options
         WHERE product_id = $3 AND variant_id = $4`,
        [cloneId, clonedVariantId, productId, variant.variant_id]
      );
    }

    const standaloneOptions = await client.query<{
      option_count: string | number;
    }>(
      `SELECT COUNT(*) AS option_count
       FROM product_options
       WHERE product_id = $1 AND variant_id IS NULL`,
      [productId]
    );
    if (Number(standaloneOptions.rows[0]?.option_count ?? 0) > 0) {
      let defaultVariantId = [...variantIds.values()][
        variantsResult.rows.findIndex((variant) => variant.title === null)
      ];
      if (!defaultVariantId) {
        const defaultVariant = await client.query<{ variant_id: string }>(
          `INSERT INTO product_variants (
             product_id, title, price, price_minor, currency,
             regiondo_variant_id, regiondo_product_id, regiondo_raw
           ) VALUES ($1, NULL, $2::numeric / 100, $2, $3, NULL, NULL, NULL)
           RETURNING variant_id`,
          [cloneId, source.price_minor, source.currency]
        );
        defaultVariantId = defaultVariant.rows[0]?.variant_id;
      }
      if (!defaultVariantId) throw new Error('Cloned default variant could not be created.');
      await client.query(
        `INSERT INTO product_options (
           product_id, variant_id, title, values_json, price_delta_minor,
           currency, regiondo_option_id, regiondo_product_id,
           regiondo_variant_id, regiondo_raw, duration_delta_minutes
         )
         SELECT $1, $2, title, values_json, price_delta_minor, currency,
                NULL, NULL, NULL, NULL, duration_delta_minutes
         FROM product_options
         WHERE product_id = $3 AND variant_id IS NULL`,
        [cloneId, defaultVariantId, productId]
      );
    }

    const offeringsResult = await client.query<{
      product_offering_id: string;
      location_id: string;
      enabled: boolean;
      time_selection_mode: string;
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
      pricing_mode: string;
      date_range_billing_unit: string;
    }>(
      `SELECT product_offering_id, location_id, enabled, time_selection_mode,
              timezone, fixed_start_time, fixed_end_time, earliest_start_time,
              latest_start_time, start_interval_minutes, min_participants,
              max_participants, min_duration_minutes, max_duration_minutes,
              duration_step_minutes, default_duration_minutes,
              allowed_duration_minutes, min_advance_minutes, max_advance_days,
              same_day_booking_allowed, pricing_mode, date_range_billing_unit
       FROM location_products
       WHERE product_id = $1
       ORDER BY created_at ASC, product_offering_id ASC`,
      [productId]
    );
    for (const offering of offeringsResult.rows) {
      const clonedOffering = await client.query<{
        product_offering_id: string;
      }>(
        `INSERT INTO location_products (
           location_id, product_id, enabled, booking_provider,
           time_selection_mode, timezone, fixed_start_time, fixed_end_time,
           earliest_start_time, latest_start_time, start_interval_minutes,
           min_participants, max_participants, min_duration_minutes,
           max_duration_minutes, duration_step_minutes, default_duration_minutes,
           allowed_duration_minutes, min_advance_minutes, max_advance_days,
           same_day_booking_allowed, pricing_mode, date_range_billing_unit
         ) VALUES (
           $1, $2, $3, 'core', $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
         )
         RETURNING product_offering_id`,
        [
          offering.location_id,
          cloneId,
          offering.enabled,
          offering.time_selection_mode,
          offering.timezone,
          offering.fixed_start_time,
          offering.fixed_end_time,
          offering.earliest_start_time,
          offering.latest_start_time,
          offering.start_interval_minutes,
          offering.min_participants,
          offering.max_participants,
          offering.min_duration_minutes,
          offering.max_duration_minutes,
          offering.duration_step_minutes,
          offering.default_duration_minutes,
          offering.allowed_duration_minutes,
          offering.min_advance_minutes,
          offering.max_advance_days,
          offering.same_day_booking_allowed,
          offering.pricing_mode,
          offering.date_range_billing_unit
        ]
      );
      const clonedOfferingId = clonedOffering.rows[0]?.product_offering_id;
      if (!clonedOfferingId) throw new Error('Cloned product offering could not be created.');
      await client.query(
        `INSERT INTO product_offering_resources (
           product_offering_id, resource_id, quantity, scaling_mode
         )
         SELECT $1, resource_id, quantity, scaling_mode
         FROM product_offering_resources
         WHERE product_offering_id = $2`,
        [clonedOfferingId, offering.product_offering_id]
      );
    }

    await client.query(
      `INSERT INTO product_resources (product_id, resource_id, quantity)
       SELECT $1, resource_id, quantity
       FROM product_resources
       WHERE product_id = $2`,
      [cloneId, productId]
    );

    const rulesResult = await client.query<{
      location_id: string | null;
      product_variant_id: string | null;
      resource_id: string | null;
      rule_type: string;
      starts_at: string | null;
      ends_at: string | null;
      weekdays: number[] | null;
      local_start_time: string | null;
      local_end_time: string | null;
      timezone: string;
      capacity_override: number | null;
      is_active: boolean;
      metadata: unknown;
    }>(
      `SELECT location_id, product_variant_id, resource_id, rule_type, starts_at,
              ends_at, weekdays, local_start_time, local_end_time, timezone,
              capacity_override, is_active, metadata
       FROM availability_rules
       WHERE product_id = $1
       ORDER BY created_at ASC, availability_rule_id ASC`,
      [productId]
    );
    for (const rule of rulesResult.rows) {
      const clonedVariantId = rule.product_variant_id ? variantIds.get(rule.product_variant_id) : null;
      if (rule.product_variant_id && !clonedVariantId) continue;
      await client.query(
        `INSERT INTO availability_rules (
           location_id, product_id, product_variant_id, resource_id, rule_type,
           starts_at, ends_at, weekdays, local_start_time, local_end_time,
           timezone, capacity_override, is_active, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          rule.location_id,
          cloneId,
          clonedVariantId,
          rule.resource_id,
          rule.rule_type,
          rule.starts_at,
          rule.ends_at,
          rule.weekdays,
          rule.local_start_time,
          rule.local_end_time,
          rule.timezone,
          rule.capacity_override,
          rule.is_active,
          rule.metadata
        ]
      );
    }

    return cloneId;
  });

  return clonedProductId ? getAdminProduct(clonedProductId) : null;
}

export async function deleteAdminProduct(productId: string): Promise<'deleted' | 'not_found' | 'in_use'> {
  try {
    const result = await pool.query(
      `DELETE FROM products
       WHERE product_id = $1
       RETURNING product_id`,
      [productId]
    );
    return result.rowCount ? 'deleted' : 'not_found';
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return 'in_use';
    throw error;
  }
}

export async function listLocationProducts(locationId: string): Promise<AdminProduct[]> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     WHERE EXISTS (
       SELECT 1 FROM location_products offering
       WHERE offering.location_id = $1
         AND offering.product_id = p.product_id
         AND offering.enabled = true
     )
     GROUP BY p.product_id
     ORDER BY p.title ASC`,
    [locationId]
  );

  return mapAdminProducts(result.rows);
}

export async function addProductOffering(locationId: string, productId: string): Promise<AdminProduct | null> {
  const result = await pool.query(
    `INSERT INTO location_products (location_id, product_id, enabled, booking_provider)
     SELECT location.location_id, product.product_id, true, product.booking_provider
     FROM locations location
     CROSS JOIN products product
     WHERE location.location_id = $1 AND product.product_id = $2
     ON CONFLICT (location_id, product_id)
     DO UPDATE SET enabled = true, updated_at = now()
     RETURNING product_id`,
    [locationId, productId]
  );

  return result.rowCount ? getAdminProduct(productId) : null;
}

export interface UpdateProductOfferingInput {
  bookingProvider?: 'core' | 'regiondo';
  regiondoProductId?: string;
  timeSelectionMode?: 'date_range' | 'start_end' | 'start_duration' | 'fixed_duration';
  timezone?: string;
  fixedStartTime?: string | null;
  fixedEndTime?: string | null;
  earliestStartTime?: string | null;
  latestStartTime?: string | null;
  startIntervalMinutes?: number;
  minParticipants?: number;
  maxParticipants?: number;
  minDurationMinutes?: number | null;
  maxDurationMinutes?: number | null;
  durationStepMinutes?: number | null;
  defaultDurationMinutes?: number | null;
  allowedDurationMinutes?: number[] | null;
  minAdvanceMinutes?: number;
  maxAdvanceDays?: number | null;
  sameDayBookingAllowed?: boolean;
  enabled?: boolean;
  pricingMode?: 'once' | 'per_quantity' | 'per_date_unit' | 'per_date_unit_per_quantity';
  dateRangeBillingUnit?: 'nights' | 'calendar_days';
}

export async function updateProductOffering(
  locationId: string,
  productId: string,
  input: UpdateProductOfferingInput
): Promise<AdminProduct | null> {
  const updated = await withTransaction(async (client) => {
    const current = await client.query<{
      product_offering_id: string;
      booking_provider: 'core' | 'regiondo';
      time_selection_mode: string;
      pricing_mode: UpdateProductOfferingInput['pricingMode'];
    }>(
      `SELECT product_offering_id, booking_provider, time_selection_mode, pricing_mode
       FROM location_products WHERE location_id = $1 AND product_id = $2 FOR UPDATE`,
      [locationId, productId]
    );
    if (!current.rowCount) return false;
    const offeringId = current.rows[0].product_offering_id;
    const nextProvider = input.bookingProvider ?? current.rows[0].booking_provider;
    const nextTimeMode = input.timeSelectionMode ?? current.rows[0].time_selection_mode;
    const nextPricingMode = input.pricingMode ?? current.rows[0].pricing_mode;
    if (nextPricingMode?.includes('date_unit') && nextTimeMode !== 'date_range') {
      throw new BookingRuleValidationError('Per-date-unit pricing requires date-range time selection.');
    }
    if (nextProvider === 'core' && current.rows[0].booking_provider !== 'core') {
      const readiness = await client.query<{
        variants: string | number;
        resources: string | number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM product_variants WHERE product_id = $1 AND regiondo_variant_id IS NULL) AS variants,
           (SELECT COUNT(*) FROM product_offering_resources WHERE product_offering_id = $2) AS resources`,
        [productId, offeringId]
      );
      if (Number(readiness.rows[0]?.resources ?? 0) < 1) {
        throw new Error('Prepare Core resource requirements before switching this offering to Core.');
      }
    }
    if (nextProvider === 'regiondo') {
      const externalId = input.regiondoProductId?.trim();
      const existingReference = await client.query(
        `SELECT 1 FROM provider_references
         WHERE provider = 'regiondo' AND entity_type = 'product_offering' AND entity_id = $1`,
        [offeringId]
      );
      if (!externalId && !existingReference.rowCount) {
        throw new Error('A Regiondo product mapping is required for a Regiondo offering.');
      }
      if (externalId) {
        await client.query(
          `INSERT INTO provider_references (provider, entity_type, entity_id, external_id)
           VALUES ('regiondo', 'product_offering', $1, $2)
           ON CONFLICT (provider, entity_type, entity_id)
           DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = now()`,
          [offeringId, externalId]
        );
      }
    }
    await client.query(
      `UPDATE location_products SET
         booking_provider = COALESCE($3, booking_provider),
         time_selection_mode = COALESCE($4, time_selection_mode),
         timezone = COALESCE($5, timezone),
         fixed_start_time = CASE WHEN $23::boolean THEN $24::time ELSE fixed_start_time END,
         fixed_end_time = CASE WHEN $25::boolean THEN $26::time ELSE fixed_end_time END,
         pricing_mode = COALESCE($27, pricing_mode),
         date_range_billing_unit = COALESCE($28, date_range_billing_unit),
         earliest_start_time = CASE WHEN $29::boolean THEN $30::time ELSE earliest_start_time END,
         latest_start_time = CASE WHEN $31::boolean THEN $32::time ELSE latest_start_time END,
         start_interval_minutes = COALESCE($33, start_interval_minutes),
         min_participants = COALESCE($6, min_participants),
         max_participants = COALESCE($7, max_participants),
         min_duration_minutes = CASE WHEN $8::boolean THEN $9 ELSE min_duration_minutes END,
         max_duration_minutes = CASE WHEN $10::boolean THEN $11 ELSE max_duration_minutes END,
         duration_step_minutes = CASE WHEN $12::boolean THEN $13 ELSE duration_step_minutes END,
         default_duration_minutes = CASE WHEN $14::boolean THEN $15 ELSE default_duration_minutes END,
         allowed_duration_minutes = CASE WHEN $16::boolean THEN $17::integer[] ELSE allowed_duration_minutes END,
         min_advance_minutes = COALESCE($18, min_advance_minutes),
         max_advance_days = CASE WHEN $19::boolean THEN $20 ELSE max_advance_days END,
         same_day_booking_allowed = COALESCE($21, same_day_booking_allowed),
         enabled = COALESCE($22, enabled),
         updated_at = now()
       WHERE product_offering_id = $1 AND product_id = $2`,
      [
        offeringId,
        productId,
        input.bookingProvider ?? null,
        input.timeSelectionMode ?? null,
        input.timezone ?? null,
        input.minParticipants ?? null,
        input.maxParticipants ?? null,
        'minDurationMinutes' in input,
        input.minDurationMinutes ?? null,
        'maxDurationMinutes' in input,
        input.maxDurationMinutes ?? null,
        'durationStepMinutes' in input,
        input.durationStepMinutes ?? null,
        'defaultDurationMinutes' in input,
        input.defaultDurationMinutes ?? null,
        'allowedDurationMinutes' in input,
        input.allowedDurationMinutes ?? null,
        input.minAdvanceMinutes ?? null,
        'maxAdvanceDays' in input,
        input.maxAdvanceDays ?? null,
        input.sameDayBookingAllowed ?? null,
        input.enabled ?? null,
        'fixedStartTime' in input,
        input.fixedStartTime ?? null,
        'fixedEndTime' in input,
        input.fixedEndTime ?? null,
        input.pricingMode ?? null,
        input.dateRangeBillingUnit ?? null,
        'earliestStartTime' in input,
        input.earliestStartTime ?? null,
        'latestStartTime' in input,
        input.latestStartTime ?? null,
        input.startIntervalMinutes ?? null
      ]
    );
    return true;
  });
  return updated ? getAdminProduct(productId) : null;
}

export async function removeProductOffering(
  locationId: string,
  productId: string
): Promise<'deleted' | 'not_found' | 'in_use'> {
  const result = await pool.query<{
    exists: boolean;
    in_use: boolean;
    deleted: boolean;
  }>(
    `WITH target AS (
       SELECT product_offering_id FROM location_products WHERE location_id = $1 AND product_id = $2
     ), blockers AS (
       SELECT 1
       FROM bookings booking
       INNER JOIN booking_products booking_product ON booking_product.booking_id = booking.booking_id
       WHERE booking.location_id = $1
         AND booking_product.product_id = $2
         AND booking.dt_to > now()
         AND booking.status NOT IN ('cancelled', 'canceled', 'rejected', 'refunded')
       UNION ALL
       SELECT 1
       FROM product_resources mapping
       INNER JOIN resources resource ON resource.resource_id = mapping.resource_id
       WHERE mapping.product_id = $2 AND resource.location_id = $1
       UNION ALL
       SELECT 1
       FROM product_offering_resources requirement
       WHERE requirement.product_offering_id IN (SELECT product_offering_id FROM target)
     ), deleted AS (
       DELETE FROM location_products
       WHERE location_id = $1 AND product_id = $2
         AND EXISTS (SELECT 1 FROM target)
         AND NOT EXISTS (SELECT 1 FROM blockers)
       RETURNING 1
     )
     SELECT
       EXISTS (SELECT 1 FROM target) AS exists,
       EXISTS (SELECT 1 FROM blockers) AS in_use,
       EXISTS (SELECT 1 FROM deleted) AS deleted`,
    [locationId, productId]
  );
  const state = result.rows[0];
  if (!state?.exists) return 'not_found';
  if (state.in_use) return 'in_use';
  return state.deleted ? 'deleted' : 'not_found';
}

export async function listRegiondoCatalogProducts(): Promise<AdminProduct[]> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     WHERE p.regiondo_product_id IS NOT NULL
     GROUP BY p.product_id
     ORDER BY p.title ASC`
  );

  return mapAdminProducts(result.rows);
}

export async function getAdminProduct(productId: string): Promise<AdminProduct | null> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     WHERE p.product_id = $1
     GROUP BY p.product_id
     LIMIT 1`,
    [productId]
  );

  if (!result.rowCount) {
    return null;
  }

  const [product] = await mapAdminProducts(result.rows);
  return product ?? null;
}

export async function updateAdminProduct(
  productId: string,
  input: {
    title?: string;
    description?: string | null;
    imageUrl?: string | null;
    baseAmount?: number;
    bookingProvider?: 'core' | 'regiondo';
    vatBasisPoints?: number;
  }
): Promise<AdminProduct | null> {
  const existing = await getAdminProduct(productId);
  if (!existing) {
    return null;
  }

  await pool.query(
    `UPDATE products
     SET
       title = $1,
       description = $2,
       image_url = $3,
       base_amount = $4,
       price_minor = $5,
       booking_provider = $6,
       vat_basis_points = $7
     WHERE product_id = $8`,
    [
      input.title?.trim() || existing.title,
      input.description === undefined ? existing.description : input.description,
      input.imageUrl === undefined ? existing.imageUrl : input.imageUrl,
      input.baseAmount ?? existing.baseAmount,
      input.baseAmount === undefined ? existing.priceMinor : Math.round(input.baseAmount * 100),
      input.bookingProvider ?? existing.bookingProvider,
      input.vatBasisPoints ?? existing.vatBasisPoints,
      productId
    ]
  );

  return getAdminProduct(productId);
}

export async function upsertProductResourceMapping(input: {
  productId: string;
  resourceId: string;
  quantity: number;
}): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO product_resources (product_id, resource_id, quantity)
     SELECT $1, resource.resource_id, $3
     FROM resources resource
     WHERE resource.resource_id = $2
       AND EXISTS (
         SELECT 1 FROM location_products offering
         WHERE offering.product_id = $1
           AND offering.location_id = resource.location_id
           AND offering.enabled = true
       )
     ON CONFLICT (product_id, resource_id)
     DO UPDATE SET quantity = EXCLUDED.quantity
     RETURNING resource_id`,
    [input.productId, input.resourceId, input.quantity]
  );
  return Boolean(result.rowCount);
}

export async function deleteProductResourceMapping(productId: string, resourceId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM product_resources
     WHERE product_id = $1
       AND resource_id = $2`,
    [productId, resourceId]
  );

  return Boolean(result.rowCount);
}

async function getCatalogOwnership(productId: string): Promise<'core' | 'regiondo' | null> {
  const result = await pool.query<{ booking_provider: 'core' | 'regiondo' }>(
    `SELECT booking_provider FROM products WHERE product_id = $1`,
    [productId]
  );
  return result.rows[0]?.booking_provider ?? null;
}

export async function createProductVariant(
  productId: string,
  input: AdminProductVariantInput
): Promise<AdminProductVariant | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';

  try {
    const result = await pool.query<{
      variant_id: string;
      title: string | null;
      price_minor: string | number;
      currency: string;
      duration_minutes: number | null;
      is_active: boolean;
      schedule_rule_enabled: boolean;
      allowed_weekdays: number[] | null;
      local_start_time: string | null;
      local_end_time: string | null;
    }>(
      `INSERT INTO product_variants (
         product_id, title, price, price_minor, currency,
         regiondo_variant_id, regiondo_product_id, regiondo_raw, duration_minutes,
         is_active, schedule_rule_enabled, allowed_weekdays, local_start_time, local_end_time
       ) VALUES ($1, $2, $3::numeric / 100, $3, $4, NULL, NULL, NULL, $5, $6, $7, $8, $9::time, $10::time)
       RETURNING variant_id, title, price_minor, currency, duration_minutes,
                 is_active, schedule_rule_enabled, allowed_weekdays,
                 to_char(local_start_time, 'HH24:MI') AS local_start_time,
                 to_char(local_end_time, 'HH24:MI') AS local_end_time`,
      [
        productId,
        input.title,
        input.priceMinor,
        input.currency,
        input.durationOverrideMinutes ?? null,
        input.active ?? true,
        input.scheduleRuleEnabled ?? false,
        input.allowedWeekdays ?? null,
        input.localStartTime ?? null,
        input.localEndTime ?? null
      ]
    );
    const row = result.rows[0];
    return {
      variantId: row.variant_id,
      title: row.title,
      priceMinor: Number(row.price_minor),
      currency: row.currency,
      isDefault: row.title === null,
      providerManaged: false,
      durationOverrideMinutes: row.duration_minutes,
      active: row.is_active,
      scheduleRuleEnabled: row.schedule_rule_enabled,
      allowedWeekdays: row.allowed_weekdays,
      localStartTime: row.local_start_time,
      localEndTime: row.local_end_time,
      options: []
    };
  } catch (error) {
    if ((error as { code?: string }).code === '23505' && input.title === null) return 'default_exists';
    throw error;
  }
}

export async function updateProductVariant(
  productId: string,
  variantId: string,
  input: Partial<AdminProductVariantInput>
): Promise<AdminProductVariant | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';

  try {
    const result = await pool.query<{
      variant_id: string;
      title: string | null;
      price_minor: string | number;
      currency: string;
      duration_minutes: number | null;
      is_active: boolean;
      schedule_rule_enabled: boolean;
      allowed_weekdays: number[] | null;
      local_start_time: string | null;
      local_end_time: string | null;
    }>(
      `UPDATE product_variants
       SET title = CASE WHEN $3::boolean THEN $4::text ELSE title END,
           price_minor = COALESCE($5, price_minor),
           price = COALESCE($5::numeric / 100, price),
           currency = COALESCE($6, currency),
           duration_minutes = CASE WHEN $7::boolean THEN $8::integer ELSE duration_minutes END,
           is_active = COALESCE($9, is_active),
           schedule_rule_enabled = COALESCE($10, schedule_rule_enabled),
           allowed_weekdays = CASE WHEN $11::boolean THEN $12::smallint[] ELSE allowed_weekdays END,
           local_start_time = CASE WHEN $13::boolean THEN $14::time ELSE local_start_time END,
           local_end_time = CASE WHEN $15::boolean THEN $16::time ELSE local_end_time END,
           updated_at = now()
       WHERE product_id = $1 AND variant_id = $2 AND regiondo_variant_id IS NULL
       RETURNING variant_id, title, price_minor, currency, duration_minutes,
                 is_active, schedule_rule_enabled, allowed_weekdays,
                 to_char(local_start_time, 'HH24:MI') AS local_start_time,
                 to_char(local_end_time, 'HH24:MI') AS local_end_time`,
      [
        productId,
        variantId,
        input.title !== undefined,
        input.title ?? null,
        input.priceMinor ?? null,
        input.currency ?? null,
        'durationOverrideMinutes' in input,
        input.durationOverrideMinutes ?? null,
        input.active ?? null,
        input.scheduleRuleEnabled ?? null,
        'allowedWeekdays' in input,
        input.allowedWeekdays ?? null,
        'localStartTime' in input,
        input.localStartTime ?? null,
        'localEndTime' in input,
        input.localEndTime ?? null
      ]
    );
    if (!result.rowCount) return 'not_found';
    const row = result.rows[0];
    return {
      variantId: row.variant_id,
      title: row.title,
      priceMinor: Number(row.price_minor),
      currency: row.currency,
      isDefault: row.title === null,
      providerManaged: false,
      durationOverrideMinutes: row.duration_minutes,
      active: row.is_active,
      scheduleRuleEnabled: row.schedule_rule_enabled,
      allowedWeekdays: row.allowed_weekdays,
      localStartTime: row.local_start_time,
      localEndTime: row.local_end_time,
      options: []
    };
  } catch (error) {
    if ((error as { code?: string }).code === '23505' && input.title === null) return 'default_exists';
    throw error;
  }
}

export async function deleteProductVariant(
  productId: string,
  variantId: string
): Promise<'deleted' | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';

  try {
    const result = await pool.query(
      `DELETE FROM product_variants
       WHERE product_id = $1 AND variant_id = $2 AND regiondo_variant_id IS NULL
       RETURNING variant_id`,
      [productId, variantId]
    );
    return result.rowCount ? 'deleted' : 'not_found';
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return 'in_use';
    throw error;
  }
}

export async function createProductOption(
  productId: string,
  variantId: string,
  input: AdminProductOptionInput
): Promise<AdminProductOption | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';
  const result = await pool.query<{
    option_id: string;
    title: string;
    values_json: unknown;
    price_delta_minor: string | number;
    currency: string;
    duration_delta_minutes: number;
  }>(
    `INSERT INTO product_options (
       product_id, variant_id, title, values_json, price_delta_minor, currency,
       regiondo_option_id, regiondo_product_id, regiondo_variant_id, regiondo_raw, duration_delta_minutes
     )
     SELECT $1, variant.variant_id, $3, $4::jsonb, $5, $6, NULL, NULL, NULL, NULL, $7
     FROM product_variants variant
     WHERE variant.product_id = $1 AND variant.variant_id = $2 AND variant.regiondo_variant_id IS NULL
     RETURNING option_id, title, values_json, price_delta_minor, currency, duration_delta_minutes`,
    [
      productId,
      variantId,
      input.title,
      JSON.stringify(input.values),
      input.priceDeltaMinor,
      input.currency,
      input.durationDeltaMinutes ?? 0
    ]
  );
  if (!result.rowCount) return 'not_found';
  const row = result.rows[0];
  return {
    optionId: row.option_id,
    title: row.title,
    values: input.values,
    priceDeltaMinor: Number(row.price_delta_minor),
    currency: row.currency,
    providerManaged: false,
    durationDeltaMinutes: row.duration_delta_minutes
  };
}

export async function updateProductOption(
  productId: string,
  variantId: string,
  optionId: string,
  input: Partial<AdminProductOptionInput>
): Promise<AdminProductOption | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';
  const result = await pool.query<{
    option_id: string;
    title: string;
    values_json: unknown;
    price_delta_minor: string | number;
    currency: string;
    duration_delta_minutes: number;
  }>(
    `UPDATE product_options option_record
     SET title = COALESCE($4, option_record.title),
         values_json = COALESCE($5::jsonb, option_record.values_json),
         price_delta_minor = COALESCE($6, option_record.price_delta_minor),
         currency = COALESCE($7, option_record.currency),
         duration_delta_minutes = COALESCE($8, option_record.duration_delta_minutes),
         updated_at = now()
     FROM product_variants variant
     WHERE option_record.product_id = $1
       AND option_record.variant_id = $2
       AND option_record.option_id = $3
       AND option_record.regiondo_option_id IS NULL
       AND variant.variant_id = option_record.variant_id
       AND variant.product_id = $1
       AND variant.regiondo_variant_id IS NULL
     RETURNING option_record.option_id, option_record.title, option_record.values_json,
               option_record.price_delta_minor, option_record.currency, option_record.duration_delta_minutes`,
    [
      productId,
      variantId,
      optionId,
      input.title ?? null,
      input.values === undefined ? null : JSON.stringify(input.values),
      input.priceDeltaMinor ?? null,
      input.currency ?? null,
      input.durationDeltaMinutes ?? null
    ]
  );
  if (!result.rowCount) return 'not_found';
  const row = result.rows[0];
  return {
    optionId: row.option_id,
    title: row.title,
    values: Array.isArray(row.values_json)
      ? row.values_json.filter((value): value is string => typeof value === 'string')
      : [],
    priceDeltaMinor: Number(row.price_delta_minor),
    currency: row.currency,
    providerManaged: false,
    durationDeltaMinutes: row.duration_delta_minutes
  };
}

export async function deleteProductOption(
  productId: string,
  variantId: string,
  optionId: string
): Promise<'deleted' | CatalogMutationFailure> {
  const ownership = await getCatalogOwnership(productId);
  if (!ownership) return 'not_found';
  if (ownership !== 'core') return 'provider_managed';
  const result = await pool.query(
    `DELETE FROM product_options option_record
     USING product_variants variant
     WHERE option_record.product_id = $1
       AND option_record.variant_id = $2
       AND option_record.option_id = $3
       AND option_record.regiondo_option_id IS NULL
       AND variant.variant_id = option_record.variant_id
       AND variant.product_id = $1
       AND variant.regiondo_variant_id IS NULL
     RETURNING option_record.option_id`,
    [productId, variantId, optionId]
  );
  return result.rowCount ? 'deleted' : 'not_found';
}

export async function prepareProductCoreMigration(productId: string): Promise<AdminProduct | CatalogMutationFailure> {
  const result = await withTransaction(async (client) => {
    const productResult = await client.query<{
      booking_provider: 'core' | 'regiondo';
      currency: string;
      regiondo_product_id: string | null;
    }>(`SELECT booking_provider, currency, regiondo_product_id FROM products WHERE product_id = $1 FOR UPDATE`, [
      productId
    ]);
    const product = productResult.rows[0];
    if (!product) return 'not_found' as const;
    if (product.booking_provider !== 'regiondo' || !product.regiondo_product_id) return 'provider_managed' as const;

    const existing = await client.query(
      `SELECT 1 FROM product_variants WHERE product_id = $1 AND regiondo_variant_id IS NULL LIMIT 1`,
      [productId]
    );
    if (existing.rowCount) return 'prepared' as const;

    const sourceVariants = await client.query<{
      variant_id: string;
      regiondo_variant_id: string;
      title: string | null;
      price: string | number;
      price_minor: string | number | null;
      currency: string;
    }>(
      `SELECT variant_id, regiondo_variant_id, title, price, price_minor, currency
       FROM product_variants
       WHERE product_id = $1 AND regiondo_variant_id IS NOT NULL
       ORDER BY created_at ASC, variant_id ASC`,
      [productId]
    );
    if (!sourceVariants.rowCount) return 'not_found' as const;

    for (const source of sourceVariants.rows) {
      const preparedTitle =
        source.title ?? (sourceVariants.rows.length === 1 ? null : `Regiondo variant ${source.regiondo_variant_id}`);
      const copied = await client.query<{ variant_id: string }>(
        `INSERT INTO product_variants (
           product_id, title, price, price_minor, currency,
           regiondo_variant_id, regiondo_product_id, regiondo_raw
         ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6::jsonb)
         RETURNING variant_id`,
        [
          productId,
          preparedTitle,
          source.price,
          source.price_minor ?? Math.round(Number(source.price) * 100),
          source.currency || product.currency,
          JSON.stringify({
            coreMigration: {
              provider: 'regiondo',
              sourceVariantId: source.variant_id,
              externalId: source.regiondo_variant_id
            }
          })
        ]
      );
      const copiedVariantId = copied.rows[0].variant_id;
      await client.query(
        `INSERT INTO product_options (
           product_id, variant_id, title, values_json, price_delta_minor, currency,
           regiondo_option_id, regiondo_product_id, regiondo_variant_id, regiondo_raw
         )
         SELECT option_record.product_id, $3, option_record.title, option_record.values_json,
                option_record.price_delta_minor, option_record.currency,
                NULL, NULL, NULL,
                jsonb_build_object('coreMigration', jsonb_build_object(
                  'provider', 'regiondo',
                  'sourceOptionId', option_record.option_id,
                  'externalId', option_record.regiondo_option_id
                ))
         FROM product_options option_record
         WHERE option_record.product_id = $1 AND option_record.variant_id = $2
           AND option_record.regiondo_option_id IS NOT NULL`,
        [productId, source.variant_id, copiedVariantId]
      );
      await client.query(
        `UPDATE provider_references
         SET metadata = metadata || jsonb_build_object('preparedCoreVariantId', $3::text), updated_at = now()
         WHERE provider = 'regiondo' AND entity_type = 'product_variant'
           AND entity_id = $2 AND external_id = $1`,
        [source.regiondo_variant_id, source.variant_id, copiedVariantId]
      );
    }

    await client.query(
      `UPDATE provider_references
       SET metadata = metadata || jsonb_build_object('coreMigrationPreparedAt', now()), updated_at = now()
       WHERE provider = 'regiondo' AND entity_type = 'product' AND entity_id = $1`,
      [productId]
    );
    return 'prepared' as const;
  });

  if (result === 'not_found' || result === 'provider_managed') return result;
  return (await getAdminProduct(productId)) ?? 'not_found';
}

export async function validateCoreProviderSwitch(productId: string): Promise<CoreProviderSwitchValidation> {
  const result = await pool.query<{
    native_variant_count: string | number;
    invalid_variant_count: string | number;
    invalid_option_count: string | number;
    location_count: string | number;
    resource_count: string | number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM product_variants variant
        WHERE variant.product_id = product.product_id AND variant.regiondo_variant_id IS NULL) AS native_variant_count,
       (SELECT COUNT(*) FROM product_variants variant
        WHERE variant.product_id = product.product_id AND variant.regiondo_variant_id IS NULL
          AND (variant.price_minor IS NULL OR variant.price_minor < 0 OR variant.currency <> product.currency)) AS invalid_variant_count,
       (SELECT COUNT(*) FROM product_options option_record
        INNER JOIN product_variants variant ON variant.variant_id = option_record.variant_id
        WHERE option_record.product_id = product.product_id AND variant.regiondo_variant_id IS NULL
          AND (option_record.title IS NULL OR BTRIM(option_record.title) = '' OR option_record.currency <> product.currency)) AS invalid_option_count,
       (SELECT COUNT(*) FROM location_products offering
        WHERE offering.product_id = product.product_id AND offering.enabled = true) AS location_count,
       (SELECT COUNT(*) FROM product_resources mapping
        WHERE mapping.product_id = product.product_id) AS resource_count
     FROM products product WHERE product.product_id = $1`,
    [productId]
  );
  const row = result.rows[0];
  if (!row) return { valid: false, issues: ['Product not found.'] };
  const issues: string[] = [];
  if (!Number(row.native_variant_count)) issues.push('Prepare and review at least one Core variant.');
  if (Number(row.invalid_variant_count)) issues.push('Core variant pricing and currency must be valid.');
  if (Number(row.invalid_option_count)) issues.push('Core option names and currency must be valid.');
  if (!Number(row.location_count)) issues.push('Assign at least one enabled location.');
  if (!Number(row.resource_count)) issues.push('Assign at least one resource for Core availability.');
  return { valid: issues.length === 0, issues };
}
