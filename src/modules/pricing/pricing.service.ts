import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { netFromGross, percentageOf } from '../commerce/money.js';
import type { PricingMode } from '../bookings/booking-intent.js';

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingValidationError';
  }
}

function optionValueIdentifier(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return text || null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.id ?? record.value ?? record.option_value_id
    ?? record.label ?? record.title ?? record.name;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return null;
  const text = String(candidate).trim();
  return text || null;
}

function allowedOptionValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const identifier = optionValueIdentifier(item);
    return identifier ? [identifier] : [];
  });
}

export interface PricingQuoteInput {
  productId: string;
  variantId?: string;
  options?: Array<{ optionId: string; value: string }>;
  quantity: number;
  clientId?: string;
  locationId?: string;
  locationProductId?: string;
  discountCode?: string;
  dateUnits?: number;
}

export interface PricingQuoteItem {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceNet: number;
  unitPriceGross: number;
  vatBasisPoints: number;
  subtotalNet: number;
  tax: number;
  subtotalGross: number;
  currency: string;
  options: Array<{ optionId: string; name: string; value: string; priceDelta: number }>;
  pricingMode: PricingMode;
  dateUnits: number;
  effectiveUnitRate: number;
  subtotalBeforeOptions: number;
  optionsSubtotal: number;
}

export interface PricingQuote {
  items: PricingQuoteItem[];
  subtotalNet: number;
  tax: number;
  subtotalGross: number;
  discount: number;
  total: number;
  currency: string;
  calculation: {
    mode: PricingMode;
    unitRate: number;
    quantity: number;
    dateUnits: number;
    subtotalBeforeOptions: number;
    optionsSubtotal: number;
  };
}

export function calculatePrice(input: {
  productId: string;
  variantId?: string | null;
  productName: string;
  variantName?: string | null;
  baseGross: number;
  vatBasisPoints: number;
  currency: string;
  quantity: number;
  pricingMode?: PricingMode;
  dateUnits?: number;
  options?: Array<{ optionId: string; name: string; value: string; priceDelta: number }>;
  discount?: { type: 'fixed' | 'percentage'; amountMinor?: number | null; percentageBasisPoints?: number | null };
}): PricingQuote {
  const options = input.options ?? [];
  const unitGross = input.baseGross + options.reduce((sum, option) => sum + option.priceDelta, 0);
  const pricingMode = input.pricingMode ?? 'per_quantity';
  const dateUnits = input.dateUnits ?? 1;
  if (!Number.isInteger(dateUnits) || dateUnits < 1) throw new PricingValidationError('Date units must be a positive integer.');
  const baseMultiplier = pricingMode === 'once' ? 1
    : pricingMode === 'per_quantity' ? input.quantity
      : pricingMode === 'per_date_unit' ? dateUnits
        : dateUnits * input.quantity;
  const subtotalBeforeOptions = input.baseGross * baseMultiplier;
  // Preserve established Option semantics: selected deltas scale per participant,
  // independently of the Product base-rate pricing mode.
  const optionsSubtotal = options.reduce((sum, option) => sum + option.priceDelta, 0) * input.quantity;
  const subtotalGrossBeforeDiscount = subtotalBeforeOptions + optionsSubtotal;
  const requestedDiscount = input.discount?.type === 'percentage'
    ? percentageOf(subtotalGrossBeforeDiscount, input.discount.percentageBasisPoints ?? 0)
    : input.discount?.amountMinor ?? 0;
  const discount = Math.max(0, Math.min(subtotalGrossBeforeDiscount, requestedDiscount));
  const subtotalGross = subtotalGrossBeforeDiscount - discount;
  const subtotalNet = netFromGross(subtotalGross, input.vatBasisPoints);
  const unitNet = netFromGross(unitGross, input.vatBasisPoints);
  const item: PricingQuoteItem = {
    productId: input.productId,
    variantId: input.variantId ?? null,
    productName: input.productName,
    variantName: input.variantName ?? null,
    quantity: input.quantity,
    unitPriceNet: unitNet,
    unitPriceGross: unitGross,
    vatBasisPoints: input.vatBasisPoints,
    subtotalNet,
    tax: subtotalGross - subtotalNet,
    subtotalGross,
    currency: input.currency,
    options,
    pricingMode,
    dateUnits,
    effectiveUnitRate: input.baseGross,
    subtotalBeforeOptions,
    optionsSubtotal
  };
  return {
    items: [item],
    subtotalNet,
    tax: item.tax,
    subtotalGross: subtotalGrossBeforeDiscount,
    discount,
    total: subtotalGross,
    currency: input.currency,
    calculation: {
      mode: pricingMode,
      unitRate: input.baseGross,
      quantity: input.quantity,
      dateUnits,
      subtotalBeforeOptions,
      optionsSubtotal
    }
  };
}

export async function quoteWithClient(client: PoolClient, input: PricingQuoteInput): Promise<PricingQuote> {
  const productResult = await client.query<{
    product_id: string; title: string; booking_provider: string; price_minor: string | number;
    currency: string; vat_basis_points: number; variant_id: string | null; variant_title: string | null;
    variant_price_minor: string | number | null;
    pricing_mode: PricingMode | null;
  }>(
    `SELECT product.product_id, product.title,
            COALESCE(offering.booking_provider, product.booking_provider) AS booking_provider,
            product.price_minor,
            product.currency, product.vat_basis_points,
            variant.variant_id, variant.title AS variant_title, variant.price_minor AS variant_price_minor
            , offering.pricing_mode
     FROM products product
     LEFT JOIN location_products offering
       ON offering.product_offering_id = $3::uuid
      AND offering.product_id = product.product_id
     LEFT JOIN product_variants variant
       ON variant.product_id = product.product_id
      AND (
        variant.variant_id = $2::uuid
        OR (
          $2::uuid IS NULL
          AND COALESCE(offering.booking_provider, product.booking_provider) = 'core'
          AND variant.regiondo_variant_id IS NULL
          AND variant.title IS NULL
        )
      )
      AND (
        (COALESCE(offering.booking_provider, product.booking_provider) = 'regiondo' AND variant.regiondo_variant_id IS NOT NULL)
        OR (COALESCE(offering.booking_provider, product.booking_provider) = 'core' AND variant.regiondo_variant_id IS NULL)
      )
     WHERE product.product_id = $1
       AND ($2::uuid IS NULL OR variant.variant_id IS NOT NULL)
     LIMIT 1`,
    [input.productId, input.variantId ?? null, input.locationProductId ?? null]
  );
  if (!productResult.rowCount) throw new PricingValidationError('Product or variant was not found.');
  const product = productResult.rows[0];
  const requestedOptions = input.options ?? [];
  const optionIds = requestedOptions.map((option) => option.optionId);
  const optionResult = optionIds.length
    ? await client.query<{ option_id: string; title: string | null; price_delta_minor: string | number; values_json: unknown }>(
        `SELECT option_record.option_id, option_record.title, option_record.price_delta_minor, option_record.values_json
         FROM product_options option_record
         INNER JOIN products product ON product.product_id = option_record.product_id
         WHERE option_record.option_id = ANY($1::uuid[]) AND option_record.product_id = $2
           AND ($3::uuid IS NULL OR option_record.variant_id IS NULL OR option_record.variant_id = $3::uuid)
           AND (
             ($4 = 'regiondo' AND option_record.regiondo_option_id IS NOT NULL)
             OR ($4 = 'core' AND option_record.regiondo_option_id IS NULL)
           )`,
        [optionIds, input.productId, product.variant_id, product.booking_provider]
      )
    : { rows: [], rowCount: 0 };
  if (optionResult.rows.length !== optionIds.length) {
    throw new PricingValidationError('One or more selected options are invalid.');
  }
  const valueByOption = new Map(requestedOptions.map((option) => [option.optionId, option.value]));
  for (const option of optionResult.rows) {
    const allowedValues = allowedOptionValues(option.values_json);
    const selectedValue = valueByOption.get(option.option_id);
    if (allowedValues.length && (!selectedValue || !allowedValues.includes(selectedValue))) {
      throw new PricingValidationError('One or more selected option values are invalid.');
    }
  }

  let discount: Parameters<typeof calculatePrice>[0]['discount'];
  if (input.discountCode) {
    const discountResult = await client.query<{
      discount_type: 'fixed' | 'percentage'; amount_minor: string | number | null; percentage_basis_points: number | null;
    }>(
      `SELECT discount_type, amount_minor, percentage_basis_points
       FROM discounts
       WHERE LOWER(code) = LOWER($1) AND is_active = true
         AND (valid_from IS NULL OR valid_from <= now())
         AND (valid_until IS NULL OR valid_until > now())
         AND (usage_limit IS NULL OR usage_count < usage_limit)
         AND (cardinality(product_ids) = 0 OR $2::uuid = ANY(product_ids))
         AND (cardinality(location_ids) = 0 OR $3::uuid = ANY(location_ids))
       LIMIT 1`,
      [input.discountCode, input.productId, input.locationId ?? null]
    );
    if (!discountResult.rowCount) throw new PricingValidationError('Discount code is invalid or expired.');
    const row = discountResult.rows[0];
    discount = {
      type: row.discount_type,
      amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
      percentageBasisPoints: row.percentage_basis_points
    };
  }

  return calculatePrice({
    productId: product.product_id,
    variantId: product.variant_id,
    productName: product.title,
    variantName: product.variant_title,
    baseGross: Number(product.variant_price_minor ?? product.price_minor),
    vatBasisPoints: product.vat_basis_points,
    currency: product.currency,
    quantity: input.quantity,
    pricingMode: product.booking_provider === 'core' ? product.pricing_mode ?? 'per_quantity' : 'per_quantity',
    dateUnits: product.booking_provider === 'core' ? input.dateUnits ?? 1 : 1,
    options: optionResult.rows.map((option) => ({
      optionId: option.option_id,
      name: option.title ?? 'Option',
      value: valueByOption.get(option.option_id) ?? '',
      priceDelta: Number(option.price_delta_minor)
    })),
    discount
  });
}

export const pricingService = {
  quote(input: PricingQuoteInput): Promise<PricingQuote> {
    return quoteWithClient(pool as unknown as PoolClient, input);
  }
};

