import { pool } from '../../db/pool.js';
import type {
  RegiondoCatalogOptionRowSummaryInput,
  RegiondoCatalogVariationRowSummaryInput,
  RegiondoProductCatalogSummary
} from '../regiondo/regiondo-product-catalog.js';
import { summarizeRegiondoProductCatalogFromRows } from '../regiondo/regiondo-product-catalog.js';

export interface AdminProductResourceMapping {
  resourceId: string;
  resourceTitle: string;
  quantity: number;
}

export interface AdminProductOffering {
  offeringId: string;
  productId: string;
  locationId: string;
  locationTitle: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  resources: AdminProductResourceMapping[] | null;
  locations: AdminProductOffering[] | null;
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
    locations: row.locations ?? []
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
   COALESCE(
     (
       SELECT jsonb_agg(
         jsonb_build_object(
           'offeringId', lp.product_offering_id,
           'productId', lp.product_id,
           'locationId', lp.location_id,
           'locationTitle', location.title,
           'enabled', lp.enabled,
           'createdAt', lp.created_at,
           'updatedAt', lp.updated_at
         ) ORDER BY location.title ASC
       )
       FROM location_products lp
       INNER JOIN locations location ON location.location_id = lp.location_id
       WHERE lp.product_id = p.product_id
     ),
     '[]'::jsonb
   ) AS locations,
   COALESCE(
     jsonb_agg(
       DISTINCT jsonb_build_object(
         'resourceId', r.resource_id,
         'resourceTitle', r.title,
         'quantity', pr.quantity
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
        ? regiondoCatalogByProductId.get(row.regiondo_product_id) ?? EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY
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
    `INSERT INTO location_products (location_id, product_id, enabled)
     SELECT location.location_id, product.product_id, true
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

export async function removeProductOffering(
  locationId: string,
  productId: string
): Promise<'deleted' | 'not_found' | 'in_use'> {
  const result = await pool.query<{ exists: boolean; in_use: boolean; deleted: boolean }>(
    `WITH target AS (
       SELECT 1 FROM location_products WHERE location_id = $1 AND product_id = $2
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
