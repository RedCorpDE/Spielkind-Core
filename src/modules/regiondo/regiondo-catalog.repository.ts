import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { RegiondoCatalogSyncError } from './regiondo-catalog.errors.js';
import type { RegiondoCatalogProductRecord } from './regiondo-catalog-normalizer.js';

interface RegiondoCatalogCleanupCandidateRow {
  booking_count: string | number;
  product_id: string;
  regiondo_product_id: string | null;
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
  product: RegiondoCatalogProductRecord
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

  await client.query(`DELETE FROM product_options WHERE regiondo_product_id = $1`, [product.regiondoProductId]);
  await client.query(`DELETE FROM product_variants WHERE regiondo_product_id = $1`, [product.regiondoProductId]);

  for (const variation of product.variations) {
    await client.query(
      `INSERT INTO product_variants (
         regiondo_variant_id,
         regiondo_product_id,
         title,
         price,
         appointment_type,
         date_from,
         date_to,
         regiondo_raw
       )
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::jsonb)
       ON CONFLICT (regiondo_variant_id)
       DO UPDATE SET regiondo_product_id = EXCLUDED.regiondo_product_id,
                     title = EXCLUDED.title,
                     price = EXCLUDED.price,
                     appointment_type = EXCLUDED.appointment_type,
                     date_from = EXCLUDED.date_from,
                     date_to = EXCLUDED.date_to,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [
        variation.regiondoVariantId,
        variation.regiondoProductId,
        variation.title,
        variation.price,
        variation.appointmentType,
        variation.dateFrom,
        variation.dateTo,
        JSON.stringify(variation.raw)
      ]
    );
  }

  for (const option of product.options) {
    await client.query(
      `INSERT INTO product_options (
         regiondo_option_id,
         regiondo_product_id,
         regiondo_variant_id,
         title,
         values_json,
         regiondo_raw
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (regiondo_product_id, regiondo_variant_id, regiondo_option_id)
       DO UPDATE SET title = EXCLUDED.title,
                     values_json = EXCLUDED.values_json,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [
        option.regiondoOptionId,
        option.regiondoProductId,
        option.regiondoVariantId,
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
    cursorValue?: string | null;
    metadata?: Record<string, unknown>;
    syncType: string;
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

export async function syncRegiondoCatalogProducts(
  products: RegiondoCatalogProductRecord[],
  metadata: Record<string, unknown> = {}
): Promise<void> {
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

    for (const product of products) {
      await upsertRegiondoCatalogProduct(client, product);
    }

    await upsertSyncState(client, {
      syncType: 'regiondo_catalog',
      metadata: {
        productCount: products.length,
        ...metadata
      }
    });
  });
}
