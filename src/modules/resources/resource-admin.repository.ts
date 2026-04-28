import { pool } from '../../db/pool.js';

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
}

interface ResourceRow {
  resource_id: string;
  location_id: string;
  type: string;
  capacity_available: number;
  title: string;
  description: string | null;
  image_url: string | null;
  independently_bookable: boolean;
  base_amount: string | number;
}

function mapResourceRow(row: ResourceRow): AdminResource {
  return {
    resourceId: row.resource_id,
    locationId: row.location_id,
    type: row.type,
    capacityAvailable: row.capacity_available,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    independentlyBookable: row.independently_bookable,
    baseAmount: Number(row.base_amount)
  };
}

export async function listAdminResources(locationId?: string): Promise<AdminResource[]> {
  const result = await pool.query<ResourceRow>(
    `SELECT
       resource_id,
       location_id,
       type,
       capacity_available,
       title,
       description,
       image_url,
       independently_bookable,
       base_amount
     FROM resources
     WHERE ($1::uuid IS NULL OR location_id = $1::uuid)
     ORDER BY title ASC`,
    [locationId ?? null]
  );

  return result.rows.map(mapResourceRow);
}

export async function getAdminResource(resourceId: string): Promise<AdminResource | null> {
  const result = await pool.query<ResourceRow>(
    `SELECT
       resource_id,
       location_id,
       type,
       capacity_available,
       title,
       description,
       image_url,
       independently_bookable,
       base_amount
     FROM resources
     WHERE resource_id = $1
     LIMIT 1`,
    [resourceId]
  );

  return result.rowCount ? mapResourceRow(result.rows[0]) : null;
}
