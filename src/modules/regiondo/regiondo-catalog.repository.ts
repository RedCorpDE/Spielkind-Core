import { pool } from '../../db/pool.js';
import type { RegiondoProduct } from './regiondo.types.js';

function mapProduct(product: RegiondoProduct) {
  return {
    regiondoProductId: String(product.id),
    title: product.title ?? product.product_name ?? 'Untitled Product',
    description: typeof product.description === 'string' ? product.description : null,
    imageUrl: typeof product.image_url === 'string' ? product.image_url : null,
    baseAmount: Number(product.price ?? 0),
    raw: product
  };
}

export async function upsertRegiondoCatalogProduct(product: RegiondoProduct): Promise<void> {
  const mapped = mapProduct(product);

  await pool.query(
    `INSERT INTO products (title, description, image_url, base_amount, regiondo_product_id, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   image_url = EXCLUDED.image_url,
                   base_amount = EXCLUDED.base_amount,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()`,
    [mapped.title, mapped.description, mapped.imageUrl, mapped.baseAmount, mapped.regiondoProductId, JSON.stringify(mapped.raw)]
  );

  await pool.query('DELETE FROM product_variants WHERE regiondo_product_id = $1', [mapped.regiondoProductId]);
  await pool.query('DELETE FROM product_options WHERE regiondo_product_id = $1', [mapped.regiondoProductId]);

  for (const variant of product.variants ?? []) {
    await pool.query(
      `INSERT INTO product_variants (regiondo_variant_id, regiondo_product_id, title, price, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (regiondo_variant_id)
       DO UPDATE SET title = EXCLUDED.title,
                     price = EXCLUDED.price,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [String(variant.id), mapped.regiondoProductId, variant.title ?? null, Number(variant.price ?? 0), JSON.stringify(variant)]
    );
  }

  for (const option of product.options ?? []) {
    await pool.query(
      `INSERT INTO product_options (regiondo_option_id, regiondo_product_id, title, values_json, regiondo_raw)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (regiondo_option_id)
       DO UPDATE SET title = EXCLUDED.title,
                     values_json = EXCLUDED.values_json,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [String(option.id), mapped.regiondoProductId, option.title ?? null, JSON.stringify(option.values ?? null), JSON.stringify(option)]
    );
  }
}

export async function upsertSyncState(input: {
  syncType: string;
  cursorValue?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
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
