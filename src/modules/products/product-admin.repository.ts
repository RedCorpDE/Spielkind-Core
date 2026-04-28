import { pool } from '../../db/pool.js';

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

function mapProductRow(row: ProductRow): AdminProduct {
  return {
    productId: row.product_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    baseAmount: Number(row.base_amount),
    regiondoProductId: row.regiondo_product_id,
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

export async function listAdminProducts(): Promise<AdminProduct[]> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     GROUP BY p.product_id
     ORDER BY p.title ASC`
  );

  return result.rows.map(mapProductRow);
}

export async function listRegiondoCatalogProducts(): Promise<AdminProduct[]> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     WHERE p.regiondo_product_id IS NOT NULL
     GROUP BY p.product_id
     ORDER BY p.title ASC`
  );

  return result.rows.map(mapProductRow);
}

export async function getAdminProduct(productId: string): Promise<AdminProduct | null> {
  const result = await pool.query<ProductRow>(
    `${productSelect}
     WHERE p.product_id = $1
     GROUP BY p.product_id
     LIMIT 1`,
    [productId]
  );

  return result.rowCount ? mapProductRow(result.rows[0]) : null;
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
