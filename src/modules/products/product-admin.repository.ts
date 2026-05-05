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

export interface AdminProduct {
  productId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  baseAmount: number;
  regiondoProductId: string | null;
  regiondoCatalog: RegiondoProductCatalogSummary;
  rawJson: unknown;
  resources: AdminProductResourceMapping[];
}

interface ProductRow {
  product_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  base_amount: string | number;
  regiondo_product_id: string | null;
  regiondo_raw: unknown;
  resources: AdminProductResourceMapping[] | null;
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
    regiondoProductId: row.regiondo_product_id,
    regiondoCatalog,
    rawJson: row.regiondo_raw,
    resources: row.resources ?? []
  };
}

const productSelect = `SELECT
   p.product_id,
   p.title,
   p.description,
   p.image_url,
   p.base_amount,
   p.regiondo_product_id,
   p.regiondo_raw,
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
       base_amount = $4
     WHERE product_id = $5`,
    [
      input.title?.trim() || existing.title,
      input.description === undefined ? existing.description : input.description,
      input.imageUrl === undefined ? existing.imageUrl : input.imageUrl,
      input.baseAmount ?? existing.baseAmount,
      productId
    ]
  );

  return getAdminProduct(productId);
}

export async function upsertProductResourceMapping(input: {
  productId: string;
  resourceId: string;
  quantity: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO product_resources (product_id, resource_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, resource_id)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [input.productId, input.resourceId, input.quantity]
  );
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
