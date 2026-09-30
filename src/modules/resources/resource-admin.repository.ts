import { pool } from '../../db/pool.js';

export interface AdminResourceUsage {
  offeringId: string;
  productId: string;
  productTitle: string;
  locationId: string;
  locationTitle: string;
  quantity: number;
}

export interface AdminResource {
  resourceId: string;
  locationId: string;
  type: string;
  capacityAvailable: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  independentlyBookable: boolean;
  baseAmount: number;
  operationalStatus: 'active' | 'out_of_service';
  createdAt: string;
  updatedAt: string;
  usedByOfferings: AdminResourceUsage[];
}

interface ResourceRow {
  resource_id: string; location_id: string; type: string; capacity_available: number;
  title: string; description: string | null; image_url: string | null;
  independently_bookable: boolean; base_amount: string | number;
  operational_status: AdminResource['operationalStatus']; created_at: string; updated_at: string;
  used_by_offerings: AdminResourceUsage[] | null;
}

const resourceSelect = `SELECT resource.resource_id, resource.location_id, resource.type,
  resource.capacity_available, resource.title, resource.description, resource.image_url,
  resource.independently_bookable, resource.base_amount, resource.operational_status,
  resource.created_at, resource.updated_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'offeringId', offering.product_offering_id,
      'productId', product.product_id,
      'productTitle', product.title,
      'locationId', location.location_id,
      'locationTitle', location.title,
      'quantity', requirement.quantity
    ) ORDER BY product.title ASC)
    FROM product_offering_resources requirement
    INNER JOIN location_products offering ON offering.product_offering_id = requirement.product_offering_id
    INNER JOIN products product ON product.product_id = offering.product_id
    INNER JOIN locations location ON location.location_id = offering.location_id
    WHERE requirement.resource_id = resource.resource_id
  ), '[]'::jsonb) AS used_by_offerings
FROM resources resource`;

function mapResourceRow(row: ResourceRow): AdminResource {
  return {
    resourceId: row.resource_id, locationId: row.location_id, type: row.type,
    capacityAvailable: Number(row.capacity_available), title: row.title,
    description: row.description, imageUrl: row.image_url,
    independentlyBookable: row.independently_bookable, baseAmount: Number(row.base_amount),
    operationalStatus: row.operational_status, createdAt: row.created_at, updatedAt: row.updated_at,
    usedByOfferings: row.used_by_offerings ?? []
  };
}

export async function listAdminResources(locationId?: string): Promise<AdminResource[]> {
  const result = await pool.query<ResourceRow>(
    `${resourceSelect}
     WHERE ($1::uuid IS NULL OR resource.location_id = $1::uuid)
     ORDER BY resource.title ASC`,
    [locationId ?? null]
  );
  return result.rows.map(mapResourceRow);
}

export async function getAdminResource(resourceId: string): Promise<AdminResource | null> {
  const result = await pool.query<ResourceRow>(
    `${resourceSelect} WHERE resource.resource_id = $1 LIMIT 1`,
    [resourceId]
  );
  return result.rowCount ? mapResourceRow(result.rows[0]) : null;
}

export interface AdminResourceInput {
  locationId: string;
  type:
      | "pc"
      | "room"
      | "sleeping_room"
      | "console_station"
      | "vr_headset"
      | "projector"
      | "area"
      | "equipment"
      | "custom";
  capacityAvailable: number;
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  independentlyBookable?: boolean;
  baseAmount?: number;
  operationalStatus?: AdminResource['operationalStatus'];
}

export async function createAdminResource(input: AdminResourceInput): Promise<AdminResource | null> {
  const result = await pool.query<{ resource_id: string }>(
    `INSERT INTO resources (
       location_id, type, capacity_available, title, description, image_url,
       independently_bookable, base_amount, operational_status
     )
     SELECT location.location_id, $2, $3, $4, $5, $6, $7, $8, $9
     FROM locations location WHERE location.location_id = $1
     RETURNING resource_id`,
    [input.locationId, input.type, input.capacityAvailable, input.title.trim(), input.description ?? null,
      input.imageUrl ?? null, input.independentlyBookable ?? false, input.baseAmount ?? 0,
      input.operationalStatus ?? 'active']
  );
  return result.rowCount ? getAdminResource(result.rows[0].resource_id) : null;
}

export async function updateAdminResource(
  resourceId: string,
  input: Partial<AdminResourceInput>
): Promise<AdminResource | 'not_found' | 'location_not_found' | 'location_in_use'> {
  const current = await getAdminResource(resourceId);
  if (!current) return 'not_found';
  const nextLocationId = input.locationId ?? current.locationId;
  const location = await pool.query(`SELECT 1 FROM locations WHERE location_id = $1`, [nextLocationId]);
  if (!location.rowCount) return 'location_not_found';
  if (nextLocationId !== current.locationId) {
    const mappings = await pool.query(
      `SELECT 1 FROM product_resources WHERE resource_id = $1
       UNION ALL
       SELECT 1 FROM product_offering_resources WHERE resource_id = $1
       LIMIT 1`,
      [resourceId]
    );
    if (mappings.rowCount) return 'location_in_use';
  }

  await pool.query(
    `UPDATE resources SET location_id = $2, type = $3, capacity_available = $4,
       title = $5, description = $6, image_url = $7, independently_bookable = $8,
       base_amount = $9, operational_status = $10, updated_at = now()
     WHERE resource_id = $1`,
    [resourceId, nextLocationId, input.type ?? current.type,
      input.capacityAvailable ?? current.capacityAvailable, input.title?.trim() || current.title,
      input.description === undefined ? current.description : input.description,
      input.imageUrl === undefined ? current.imageUrl : input.imageUrl,
      input.independentlyBookable ?? current.independentlyBookable,
      input.baseAmount ?? current.baseAmount, input.operationalStatus ?? current.operationalStatus]
  );
  return (await getAdminResource(resourceId)) ?? 'not_found';
}

/** DELETE is intentionally archival: historical consumption/hold rows are never removed. */
export async function archiveAdminResource(resourceId: string): Promise<AdminResource | null> {
  const result = await pool.query(
    `UPDATE resources SET operational_status = 'out_of_service', updated_at = now()
     WHERE resource_id = $1 RETURNING resource_id`,
    [resourceId]
  );
  return result.rowCount ? getAdminResource(resourceId) : null;
}
