import { pool } from '../../db/pool.js';

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

const selectProducts = `SELECT
  product.product_id, product.title, product.description, product.image_url,
  product.booking_provider, product.price_minor, product.currency, product.vat_basis_points,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', variant.variant_id,
      'title', variant.title,
      'price', jsonb_build_object('amount', variant.price_minor, 'currency', variant.currency)
    ) ORDER BY variant.title NULLS LAST)
    FROM product_variants variant
    WHERE variant.product_id = product.product_id
      AND (
        (product.booking_provider = 'regiondo' AND variant.regiondo_variant_id IS NOT NULL)
        OR (product.booking_provider = 'core' AND variant.regiondo_variant_id IS NULL)
      )
  ), '[]'::jsonb) AS variants
FROM products product`;

export async function listCatalogProducts(locationId?: string) {
  const result = await pool.query<ProductRow>(
    `${selectProducts}
     WHERE ($1::uuid IS NULL OR EXISTS (
       SELECT 1 FROM location_products lp
       WHERE lp.product_id = product.product_id AND lp.location_id = $1 AND lp.enabled = true
     ))
     ORDER BY product.title`,
    [locationId ?? null]
  );
  return result.rows.map(mapProduct);
}

export async function getCatalogProduct(productId: string) {
  const result = await pool.query<ProductRow>(`${selectProducts} WHERE product.product_id = $1 LIMIT 1`, [productId]);
  return result.rowCount ? mapProduct(result.rows[0]) : null;
}

export async function getExternalVariantReference(variantId: string): Promise<string | null> {
  const result = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM provider_references
     WHERE provider = 'regiondo' AND entity_type = 'product_variant' AND entity_id = $1 LIMIT 1`,
    [variantId]
  );
  return result.rows[0]?.external_id ?? null;
}

