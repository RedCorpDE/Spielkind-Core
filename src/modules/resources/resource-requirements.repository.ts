import type { Pool, PoolClient } from 'pg';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface ResourceRequirement {
  resource_id: string;
  resource_title: string;
  capacity_available: number;
  required_quantity: number;
  source: 'offering' | 'legacy_product';
}

/**
 * Resolve one enabled Offering's requirements. Offering rows are authoritative;
 * legacy Product mappings are used only when that Offering has no mappings at all.
 */
export async function loadResourceRequirements(
  queryable: Queryable,
  input: { productId: string; locationId: string; quantity: number; activeOnly?: boolean }
): Promise<ResourceRequirement[]> {
  const result = await queryable.query<{
    resource_id: string;
    resource_title: string;
    capacity_available: number;
    required_quantity: string | number;
    source: ResourceRequirement['source'];
  }>(
    `WITH selected_offering AS (
       SELECT product_offering_id
       FROM location_products
       WHERE product_id = $1 AND location_id = $2 AND enabled = true
       LIMIT 1
     ), offering_requirements AS (
       SELECT resource.resource_id, resource.title AS resource_title,
              resource.capacity_available,
              requirement.quantity * $3::integer AS required_quantity,
              'offering'::text AS source
       FROM selected_offering offering
       INNER JOIN product_offering_resources requirement
         ON requirement.product_offering_id = offering.product_offering_id
       INNER JOIN resources resource ON resource.resource_id = requirement.resource_id
       WHERE ($4::boolean = false OR resource.operational_status = 'active')
     ), has_offering_requirements AS (
       SELECT 1
       FROM selected_offering offering
       INNER JOIN product_offering_resources requirement
         ON requirement.product_offering_id = offering.product_offering_id
       LIMIT 1
     ), legacy_requirements AS (
       SELECT resource.resource_id, resource.title AS resource_title,
              resource.capacity_available,
              mapping.quantity * $3::integer AS required_quantity,
              'legacy_product'::text AS source
       FROM product_resources mapping
       INNER JOIN resources resource ON resource.resource_id = mapping.resource_id
       WHERE mapping.product_id = $1
         AND resource.location_id = $2
         AND ($4::boolean = false OR resource.operational_status = 'active')
         AND EXISTS (SELECT 1 FROM selected_offering)
         AND NOT EXISTS (SELECT 1 FROM has_offering_requirements)
     )
     SELECT * FROM offering_requirements
     UNION ALL
     SELECT * FROM legacy_requirements
     ORDER BY resource_id`,
    [input.productId, input.locationId, input.quantity, input.activeOnly ?? true]
  );

  return result.rows.map((row) => ({
    ...row,
    capacity_available: Number(row.capacity_available),
    required_quantity: Number(row.required_quantity)
  }));
}
