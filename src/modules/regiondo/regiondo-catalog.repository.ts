import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { RegiondoCatalogSyncError } from './regiondo-catalog.errors.js';
import type {
  RegiondoCatalogProduct,
  RegiondoCatalogVariation,
  RegiondoCatalogVariationOption
} from './regiondo.types.js';

interface RegiondoCatalogVariantRecord {
  price: number;
  raw: RegiondoCatalogVariation;
  regiondoProductId: string;
  regiondoVariantId: string;
  title: string | null;
}

interface RegiondoCatalogOptionRecord {
  raw: RegiondoCatalogVariationOption;
  regiondoOptionId: string;
  regiondoProductId: string;
  title: string | null;
  valuesJson: unknown;
}

interface RegiondoCatalogProductRecordForTest {
  baseAmount: number;
  description: string | null;
  imageUrl: string | null;
  options: RegiondoCatalogOptionRecord[];
  raw: RegiondoCatalogProduct;
  regiondoProductId: string;
  title: string;
  variations: RegiondoCatalogVariantRecord[];
}

interface RegiondoCatalogCleanupCandidateRow {
  product_id: string;
  regiondo_product_id: string | null;
  booking_count: string | number;
}

export interface RegiondoCatalogCleanupCandidateForTest {
  bookingCount: number;
  productId: string;
  regiondoProductId: string | null;
}

export interface RegiondoCatalogCleanupPlanForTest {
  blockedRows: RegiondoCatalogCleanupCandidateForTest[];
  deletableProductIds: string[];
}

const MALFORMED_REGIONDO_PRODUCT_ID_SENTINELS = new Set(['null', 'undefined']);

export function isMalformedRegiondoCatalogProductIdForTest(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '' || MALFORMED_REGIONDO_PRODUCT_ID_SENTINELS.has(normalized);
}

export function planRegiondoCatalogCleanupForTest(
  rows: RegiondoCatalogCleanupCandidateForTest[]
): RegiondoCatalogCleanupPlanForTest {
  return rows.reduce<RegiondoCatalogCleanupPlanForTest>(
    (result, row) => {
      if (row.bookingCount > 0) {
        result.blockedRows.push(row);
      } else {
        result.deletableProductIds.push(row.productId);
      }

      return result;
    },
    { blockedRows: [], deletableProductIds: [] }
  );
}

function mapRegiondoCatalogVariation(
  regiondoProductId: string,
  variation: RegiondoCatalogVariation
): RegiondoCatalogVariantRecord {
  return {
    price: variation.price ?? variation.base_price ?? variation.original_price ?? 0,
    raw: variation,
    regiondoProductId,
    regiondoVariantId: variation.variation_id,
    title: variation.title ?? null
  };
}

function mergeRegiondoCatalogOption(
  current: RegiondoCatalogOptionRecord | undefined,
  input: RegiondoCatalogVariationOption,
  regiondoProductId: string
): RegiondoCatalogOptionRecord {
  return {
    raw: input,
    regiondoOptionId: input.option_id,
    regiondoProductId,
    title: current?.title ?? input.title ?? null,
    valuesJson: current?.valuesJson ?? input.values ?? null
  };
}

export function mapRegiondoCatalogProductForTest(
  product: RegiondoCatalogProduct
): RegiondoCatalogProductRecordForTest {
  const regiondoProductId = product.product_id;
  const variations = (product.variations ?? []).map((variation) =>
    mapRegiondoCatalogVariation(regiondoProductId, variation)
  );
  const optionById = new Map<string, RegiondoCatalogOptionRecord>();

  for (const variation of product.variations ?? []) {
    for (const option of variation.options ?? []) {
      optionById.set(
        option.option_id,
        mergeRegiondoCatalogOption(optionById.get(option.option_id), option, regiondoProductId)
      );
    }
  }

  return {
    baseAmount: product.base_price ?? product.original_price ?? 0,
    description: product.short_description ?? null,
    imageUrl: product.image ?? product.thumbnail ?? null,
    options: [...optionById.values()],
    raw: product,
    regiondoProductId,
    title: product.name ?? product.default_name ?? 'Untitled Product',
    variations
  };
}

function formatBlockedCleanupRows(rows: RegiondoCatalogCleanupCandidateForTest[]): string {
  return rows
    .map((row) => `${row.regiondoProductId ?? '<null>'} (product_id=${row.productId}, bookings=${row.bookingCount})`)
    .join(', ');
}

async function listMalformedRegiondoCatalogRows(
  client: PoolClient
): Promise<RegiondoCatalogCleanupCandidateForTest[]> {
  const result = await client.query<RegiondoCatalogCleanupCandidateRow>(
    `SELECT
       p.product_id,
       p.regiondo_product_id,
       COUNT(bp.booking_id) AS booking_count
     FROM products p
     LEFT JOIN booking_products bp ON bp.product_id = p.product_id
     WHERE p.regiondo_product_id IS NOT NULL
       AND (
         BTRIM(p.regiondo_product_id) = ''
         OR LOWER(BTRIM(p.regiondo_product_id)) IN ('undefined', 'null')
       )
     GROUP BY p.product_id, p.regiondo_product_id`
  );

  return result.rows.map((row) => ({
    bookingCount: Number(row.booking_count),
    productId: row.product_id,
    regiondoProductId: row.regiondo_product_id
  }));
}

async function deleteMalformedRegiondoCatalogRows(client: PoolClient, productIds: string[]): Promise<void> {
  if (!productIds.length) {
    return;
  }

  await client.query(`DELETE FROM products WHERE product_id = ANY($1::uuid[])`, [productIds]);
}

async function upsertRegiondoCatalogProduct(
  client: PoolClient,
  product: RegiondoCatalogProductRecordForTest
): Promise<void> {
  await client.query(
    `INSERT INTO products (title, description, image_url, base_amount, regiondo_product_id, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   image_url = EXCLUDED.image_url,
                   base_amount = EXCLUDED.base_amount,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()`,
    [
      product.title,
      product.description,
      product.imageUrl,
      product.baseAmount,
      product.regiondoProductId,
      JSON.stringify(product.raw)
    ]
  );

  await client.query(`DELETE FROM product_variants WHERE regiondo_product_id = $1`, [product.regiondoProductId]);
  await client.query(`DELETE FROM product_options WHERE regiondo_product_id = $1`, [product.regiondoProductId]);

  for (const variation of product.variations) {
    await client.query(
      `INSERT INTO product_variants (regiondo_variant_id, regiondo_product_id, title, price, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (regiondo_variant_id)
       DO UPDATE SET title = EXCLUDED.title,
                     price = EXCLUDED.price,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [
        variation.regiondoVariantId,
        variation.regiondoProductId,
        variation.title,
        variation.price,
        JSON.stringify(variation.raw)
      ]
    );
  }

  for (const option of product.options) {
    await client.query(
      `INSERT INTO product_options (regiondo_option_id, regiondo_product_id, title, values_json, regiondo_raw)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (regiondo_option_id)
       DO UPDATE SET title = EXCLUDED.title,
                     values_json = EXCLUDED.values_json,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [
        option.regiondoOptionId,
        option.regiondoProductId,
        option.title,
        JSON.stringify(option.valuesJson ?? null),
        JSON.stringify(option.raw)
      ]
    );
  }
}

async function upsertSyncState(
  client: PoolClient,
  input: {
    syncType: string;
    cursorValue?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO sync_state (sync_type, cursor_value, last_success_at, last_attempt_at, metadata)
     VALUES ($1, $2, now(), now(), $3::jsonb)
     ON CONFLICT (sync_type)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value,
                   last_success_at = EXCLUDED.last_success_at,
                   last_attempt_at = EXCLUDED.last_attempt_at,
                   metadata = EXCLUDED.metadata,
                   updated_at = now()`,
    [input.syncType, input.cursorValue ?? null, JSON.stringify(input.metadata ?? {})]
  );
}

export async function syncRegiondoCatalogProducts(products: RegiondoCatalogProduct[]): Promise<void> {
  const mappedProducts = products.map(mapRegiondoCatalogProductForTest);

  await withTransaction(async (client) => {
    const cleanupPlan = planRegiondoCatalogCleanupForTest(await listMalformedRegiondoCatalogRows(client));

    if (cleanupPlan.blockedRows.length > 0) {
      throw new RegiondoCatalogSyncError(
        'Malformed Regiondo catalog rows are still referenced by bookings.',
        409,
        formatBlockedCleanupRows(cleanupPlan.blockedRows)
      );
    }

    await deleteMalformedRegiondoCatalogRows(client, cleanupPlan.deletableProductIds);

    for (const product of mappedProducts) {
      await upsertRegiondoCatalogProduct(client, product);
    }

    await upsertSyncState(client, {
      syncType: 'regiondo_catalog',
      metadata: {
        productCount: mappedProducts.length
      }
    });
  });
}
