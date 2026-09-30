import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';

export interface OfferingResourceRequirement {
  offeringId: string;
  productId: string;
  productTitle: string;
  locationId: string;
  locationTitle: string;
  resourceId: string;
  resourceTitle: string;
  quantity: number;
}

interface RequirementRow {
  product_offering_id: string;
  product_id: string;
  product_title: string;
  location_id: string;
  location_title: string;
  resource_id: string;
  resource_title: string;
  quantity: number;
}

function mapRequirement(row: RequirementRow): OfferingResourceRequirement {
  return {
    offeringId: row.product_offering_id,
    productId: row.product_id,
    productTitle: row.product_title,
    locationId: row.location_id,
    locationTitle: row.location_title,
    resourceId: row.resource_id,
    resourceTitle: row.resource_title,
    quantity: row.quantity
  };
}

const selectRequirement = `SELECT offering.product_offering_id, offering.product_id,
  product.title AS product_title, offering.location_id, location.title AS location_title,
  resource.resource_id, resource.title AS resource_title, requirement.quantity
FROM product_offering_resources requirement
INNER JOIN location_products offering
  ON offering.product_offering_id = requirement.product_offering_id
INNER JOIN products product ON product.product_id = offering.product_id
INNER JOIN locations location ON location.location_id = offering.location_id
INNER JOIN resources resource ON resource.resource_id = requirement.resource_id`;

export async function listOfferingResources(offeringId: string): Promise<OfferingResourceRequirement[] | null> {
  const offering = await pool.query(`SELECT 1 FROM location_products WHERE product_offering_id = $1`, [offeringId]);
  if (!offering.rowCount) return null;
  const result = await pool.query<RequirementRow>(
    `${selectRequirement}
     WHERE offering.product_offering_id = $1
     ORDER BY resource.title ASC`,
    [offeringId]
  );
  return result.rows.map(mapRequirement);
}

export async function upsertOfferingResource(input: {
  offeringId: string;
  resourceId: string;
  quantity: number;
}): Promise<OfferingResourceRequirement | 'offering_not_found' | 'resource_not_found' | 'wrong_location'> {
  return withTransaction(async (client) => {
    const context = await client.query<{
      offering_location_id: string | null;
      resource_location_id: string | null;
    }>(
      `SELECT
         (SELECT location_id FROM location_products WHERE product_offering_id = $1) AS offering_location_id,
         (SELECT location_id FROM resources WHERE resource_id = $2) AS resource_location_id`,
      [input.offeringId, input.resourceId]
    );
    const row = context.rows[0];
    if (!row?.offering_location_id) return 'offering_not_found';
    if (!row.resource_location_id) return 'resource_not_found';
    if (row.offering_location_id !== row.resource_location_id) return 'wrong_location';

    await client.query(
      `INSERT INTO product_offering_resources (product_offering_id, resource_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_offering_id, resource_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [input.offeringId, input.resourceId, input.quantity]
    );
    const result = await client.query<RequirementRow>(
      `${selectRequirement}
       WHERE offering.product_offering_id = $1 AND resource.resource_id = $2`,
      [input.offeringId, input.resourceId]
    );
    return mapRequirement(result.rows[0]);
  });
}

export async function deleteOfferingResource(offeringId: string, resourceId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM product_offering_resources
     WHERE product_offering_id = $1 AND resource_id = $2`,
    [offeringId, resourceId]
  );
  return Boolean(result.rowCount);
}

export async function listOfferingResourceMigrationConflicts() {
  const result = await pool.query<{
    product_id: string; resource_id: string; resource_location_id: string; reason: string; detected_at: string;
  }>(
    `SELECT product_id, resource_id, resource_location_id, reason, detected_at
     FROM product_offering_resource_migration_conflicts
     ORDER BY detected_at DESC, product_id, resource_id`
  );
  return result.rows.map((row) => ({
    productId: row.product_id,
    resourceId: row.resource_id,
    resourceLocationId: row.resource_location_id,
    reason: row.reason,
    detectedAt: row.detected_at
  }));
}
