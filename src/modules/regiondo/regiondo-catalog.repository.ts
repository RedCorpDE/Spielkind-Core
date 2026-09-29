import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { RegiondoCatalogSyncError } from './regiondo-catalog.errors.js';
import { upsertProviderReference } from '../integrations/provider-reference.repository.js';
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
  const productResult = await client.query<{ product_id: string }>(
    `INSERT INTO products (title, description, image_url, base_amount, regiondo_product_id, regiondo_raw, booking_provider, price_minor)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'regiondo', $7)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = CASE WHEN products.booking_provider = 'regiondo' THEN EXCLUDED.title ELSE products.title END,
                   description = CASE WHEN products.booking_provider = 'regiondo' THEN EXCLUDED.description ELSE products.description END,
                   image_url = CASE WHEN products.booking_provider = 'regiondo' THEN EXCLUDED.image_url ELSE products.image_url END,
                   base_amount = CASE WHEN products.booking_provider = 'regiondo' THEN EXCLUDED.base_amount ELSE products.base_amount END,
                   price_minor = CASE WHEN products.booking_provider = 'regiondo' THEN EXCLUDED.price_minor ELSE products.price_minor END,
                   booking_provider = products.booking_provider,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()
     RETURNING product_id`,
    [
      product.title,
      product.description,
      product.imageUrl,
      product.baseAmount,
      product.regiondoProductId,
      JSON.stringify(product.raw),
      Math.round(product.baseAmount * 100)
    ]
  );
  const productId = productResult.rows[0].product_id;
  await upsertProviderReference(client, {
    provider: 'regiondo', entityType: 'product', entityId: productId,
    externalId: product.regiondoProductId
  });

  await client.query(`DELETE FROM product_options WHERE regiondo_product_id = $1`, [product.regiondoProductId]);
  await client.query(`DELETE FROM product_variants WHERE regiondo_product_id = $1`, [product.regiondoProductId]);

  for (const variation of product.variations) {
    const variantResult = await client.query<{ variant_id: string }>(
      `INSERT INTO product_variants (
         product_id,
         regiondo_variant_id,
         regiondo_product_id,
         title,
         price,
         appointment_type,
         date_from,
         date_to,
         regiondo_raw,
         price_minor
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::jsonb, $10)
       ON CONFLICT (regiondo_variant_id)
       DO UPDATE SET product_id = EXCLUDED.product_id,
                     regiondo_product_id = EXCLUDED.regiondo_product_id,
                     title = EXCLUDED.title,
                     price = EXCLUDED.price,
                     price_minor = EXCLUDED.price_minor,
                     appointment_type = EXCLUDED.appointment_type,
                     date_from = EXCLUDED.date_from,
                     date_to = EXCLUDED.date_to,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING variant_id`,
      [
        productId,
        variation.regiondoVariantId,
        variation.regiondoProductId,
        variation.title,
        variation.price,
        variation.appointmentType,
        variation.dateFrom,
        variation.dateTo,
        JSON.stringify(variation.raw),
        Math.round(variation.price * 100)
      ]
    );
    await upsertProviderReference(client, {
      provider: 'regiondo', entityType: 'product_variant', entityId: variantResult.rows[0].variant_id,
      externalId: variation.regiondoVariantId, externalParentId: variation.regiondoProductId
    });
  }

  for (const option of product.options) {
    await client.query(
      `INSERT INTO product_options (
         product_id,
         variant_id,
         regiondo_option_id,
         regiondo_product_id,
         regiondo_variant_id,
         title,
         values_json,
         regiondo_raw
       )
       VALUES ($1, (SELECT variant_id FROM product_variants WHERE regiondo_variant_id = $2), $3, $4, $2, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (regiondo_product_id, regiondo_variant_id, regiondo_option_id)
       DO UPDATE SET product_id = EXCLUDED.product_id,
                     variant_id = EXCLUDED.variant_id,
                     title = EXCLUDED.title,
                     values_json = EXCLUDED.values_json,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [
        productId,
        option.regiondoVariantId,
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
