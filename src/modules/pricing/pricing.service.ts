import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { netFromGross, percentageOf } from '../commerce/money.js';

export interface PricingQuoteInput {
  productId: string;
  variantId?: string;
  options?: Array<{ optionId: string; value: string }>;
  quantity: number;
  clientId?: string;
  locationId?: string;
  discountCode?: string;
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
}

export interface PricingQuote {
  items: PricingQuoteItem[];
  subtotalNet: number;
  tax: number;
  subtotalGross: number;
  discount: number;
  total: number;
  currency: string;
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
  options?: Array<{ optionId: string; name: string; value: string; priceDelta: number }>;
  discount?: { type: 'fixed' | 'percentage'; amountMinor?: number | null; percentageBasisPoints?: number | null };
}): PricingQuote {
  const options = input.options ?? [];
  const unitGross = input.baseGross + options.reduce((sum, option) => sum + option.priceDelta, 0);
  const subtotalGrossBeforeDiscount = unitGross * input.quantity;
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
    options
  };
  return {
    items: [item],
    subtotalNet,
    tax: item.tax,
    subtotalGross: subtotalGrossBeforeDiscount,
    discount,
    total: subtotalGross,
    currency: input.currency
  };
}

export async function quoteWithClient(client: PoolClient, input: PricingQuoteInput): Promise<PricingQuote> {
  const productResult = await client.query<{
    product_id: string; title: string; booking_provider: string; price_minor: string | number;
    currency: string; vat_basis_points: number; variant_id: string | null; variant_title: string | null;
    variant_price_minor: string | number | null;
  }>(
    `SELECT product.product_id, product.title, product.booking_provider, product.price_minor,
            product.currency, product.vat_basis_points,
            variant.variant_id, variant.title AS variant_title, variant.price_minor AS variant_price_minor
     FROM products product
     LEFT JOIN product_variants variant ON variant.variant_id = $2 AND variant.product_id = product.product_id
     WHERE product.product_id = $1
       AND ($2::uuid IS NULL OR variant.variant_id IS NOT NULL)
     LIMIT 1`,
    [input.productId, input.variantId ?? null]
  );
  if (!productResult.rowCount) throw new Error('Product or variant was not found.');
  const product = productResult.rows[0];
  const requestedOptions = input.options ?? [];
  const optionIds = requestedOptions.map((option) => option.optionId);
  const optionResult = optionIds.length
    ? await client.query<{ option_id: string; title: string | null; price_delta_minor: string | number }>(
        `SELECT option_id, title, price_delta_minor FROM product_options
         WHERE option_id = ANY($1::uuid[]) AND product_id = $2
           AND ($3::uuid IS NULL OR variant_id IS NULL OR variant_id = $3::uuid)`,
        [optionIds, input.productId, input.variantId ?? null]
      )
    : { rows: [], rowCount: 0 };
  if (optionResult.rows.length !== optionIds.length) throw new Error('One or more selected options are invalid.');
  const valueByOption = new Map(requestedOptions.map((option) => [option.optionId, option.value]));

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
    if (!discountResult.rowCount) throw new Error('Discount code is invalid or expired.');
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

