import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
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

export interface AdminProductOption {
  optionId: string;
  title: string;
  values: string[];
  priceDeltaMinor: number;
  currency: string;
  providerManaged: boolean;
}

export interface AdminProductVariant {
  variantId: string;
  title: string | null;
  priceMinor: number;
  currency: string;
  isDefault: boolean;
  providerManaged: boolean;
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
}

export interface AdminProductOptionInput {
  title: string;
  values: string[];
  priceDeltaMinor: number;
  currency: string;
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
    coreMigration: row.booking_provider === 'regiondo'
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
     (
       SELECT jsonb_agg(
         jsonb_build_object(
           'variantId', variant.variant_id,
           'title', variant.title,
           'priceMinor', COALESCE(variant.price_minor, ROUND(variant.price * 100)::bigint, 0),
           'currency', variant.currency,
           'isDefault', variant.regiondo_variant_id IS NULL AND variant.title IS NULL,
           'providerManaged', variant.regiondo_variant_id IS NOT NULL,
           'options', COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'optionId', option_record.option_id,
                   'title', COALESCE(option_record.title, 'Option'),
                   'values', COALESCE(option_record.values_json, '[]'::jsonb),
                   'priceDeltaMinor', option_record.price_delta_minor,
                   'currency', option_record.currency,
                   'providerManaged', option_record.regiondo_option_id IS NOT NULL
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
    }>(
      `INSERT INTO product_variants (
         product_id, title, price, price_minor, currency,
         regiondo_variant_id, regiondo_product_id, regiondo_raw
       ) VALUES ($1, $2, $3::numeric / 100, $3, $4, NULL, NULL, NULL)
       RETURNING variant_id, title, price_minor, currency`,
      [productId, input.title, input.priceMinor, input.currency]
    );
    const row = result.rows[0];
    return {
      variantId: row.variant_id,
      title: row.title,
      priceMinor: Number(row.price_minor),
      currency: row.currency,
      isDefault: row.title === null,
      providerManaged: false,
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
    }>(
      `UPDATE product_variants
       SET title = CASE WHEN $3::boolean THEN $4::text ELSE title END,
           price_minor = COALESCE($5, price_minor),
           price = COALESCE($5::numeric / 100, price),
           currency = COALESCE($6, currency),
           updated_at = now()
       WHERE product_id = $1 AND variant_id = $2 AND regiondo_variant_id IS NULL
       RETURNING variant_id, title, price_minor, currency`,
      [productId, variantId, input.title !== undefined, input.title ?? null, input.priceMinor ?? null, input.currency ?? null]
    );
    if (!result.rowCount) return 'not_found';
    const row = result.rows[0];
    return {
      variantId: row.variant_id, title: row.title,
      priceMinor: Number(row.price_minor), currency: row.currency,
      isDefault: row.title === null, providerManaged: false, options: []
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
    option_id: string; title: string; values_json: unknown; price_delta_minor: string | number; currency: string;
  }>(
    `INSERT INTO product_options (
       product_id, variant_id, title, values_json, price_delta_minor, currency,
       regiondo_option_id, regiondo_product_id, regiondo_variant_id, regiondo_raw
     )
     SELECT $1, variant.variant_id, $3, $4::jsonb, $5, $6, NULL, NULL, NULL, NULL
     FROM product_variants variant
     WHERE variant.product_id = $1 AND variant.variant_id = $2 AND variant.regiondo_variant_id IS NULL
     RETURNING option_id, title, values_json, price_delta_minor, currency`,
    [productId, variantId, input.title, JSON.stringify(input.values), input.priceDeltaMinor, input.currency]
  );
  if (!result.rowCount) return 'not_found';
  const row = result.rows[0];
  return {
    optionId: row.option_id, title: row.title, values: input.values,
    priceDeltaMinor: Number(row.price_delta_minor), currency: row.currency, providerManaged: false
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
    option_id: string; title: string; values_json: unknown; price_delta_minor: string | number; currency: string;
  }>(
    `UPDATE product_options option_record
     SET title = COALESCE($4, option_record.title),
         values_json = COALESCE($5::jsonb, option_record.values_json),
         price_delta_minor = COALESCE($6, option_record.price_delta_minor),
         currency = COALESCE($7, option_record.currency),
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
               option_record.price_delta_minor, option_record.currency`,
    [
      productId, variantId, optionId, input.title ?? null,
      input.values === undefined ? null : JSON.stringify(input.values),
      input.priceDeltaMinor ?? null, input.currency ?? null
    ]
  );
  if (!result.rowCount) return 'not_found';
  const row = result.rows[0];
  return {
    optionId: row.option_id,
    title: row.title,
    values: Array.isArray(row.values_json) ? row.values_json.filter((value): value is string => typeof value === 'string') : [],
    priceDeltaMinor: Number(row.price_delta_minor), currency: row.currency, providerManaged: false
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
      booking_provider: 'core' | 'regiondo'; currency: string; regiondo_product_id: string | null;
    }>(
      `SELECT booking_provider, currency, regiondo_product_id FROM products WHERE product_id = $1 FOR UPDATE`,
      [productId]
    );
    const product = productResult.rows[0];
    if (!product) return 'not_found' as const;
    if (product.booking_provider !== 'regiondo' || !product.regiondo_product_id) return 'provider_managed' as const;

    const existing = await client.query(`SELECT 1 FROM product_variants WHERE product_id = $1 AND regiondo_variant_id IS NULL LIMIT 1`, [productId]);
    if (existing.rowCount) return 'prepared' as const;

    const sourceVariants = await client.query<{
      variant_id: string; regiondo_variant_id: string; title: string | null;
      price: string | number; price_minor: string | number | null; currency: string;
    }>(
      `SELECT variant_id, regiondo_variant_id, title, price, price_minor, currency
       FROM product_variants
       WHERE product_id = $1 AND regiondo_variant_id IS NOT NULL
       ORDER BY created_at ASC, variant_id ASC`,
      [productId]
    );
    if (!sourceVariants.rowCount) return 'not_found' as const;

    for (const source of sourceVariants.rows) {
      const preparedTitle = source.title ?? (
        sourceVariants.rows.length === 1 ? null : `Regiondo variant ${source.regiondo_variant_id}`
      );
      const copied = await client.query<{ variant_id: string }>(
        `INSERT INTO product_variants (
           product_id, title, price, price_minor, currency,
           regiondo_variant_id, regiondo_product_id, regiondo_raw
         ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6::jsonb)
         RETURNING variant_id`,
        [
          productId, preparedTitle, source.price, source.price_minor ?? Math.round(Number(source.price) * 100),
          source.currency || product.currency,
          JSON.stringify({ coreMigration: { provider: 'regiondo', sourceVariantId: source.variant_id, externalId: source.regiondo_variant_id } })
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
