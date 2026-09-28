import { pool } from '../../db/pool.js';

export interface AvailabilityQuery {
  location_id?: string;
  product_id?: string;
  dt_from: string;
  dt_to: string;
  guest_count: number;
}

export interface AvailabilityItem {
  resource_id: string;
  resource_title: string;
  required_quantity: number;
  capacity_available: number;
  capacity_reserved: number;
  capacity_held: number;
  capacity_remaining: number;
  is_available: boolean;
}

export function calculateAvailabilitySnapshot(input: {
  requiredQuantity: number;
  capacityAvailable: number;
  capacityReserved: number;
}): Pick<AvailabilityItem, 'required_quantity' | 'capacity_available' | 'capacity_reserved' | 'capacity_remaining' | 'is_available'> {
  const capacityRemaining = input.capacityAvailable - input.capacityReserved;

  return {
    required_quantity: input.requiredQuantity,
    capacity_available: input.capacityAvailable,
    capacity_reserved: input.capacityReserved,
    capacity_remaining: capacityRemaining,
    is_available: capacityRemaining >= input.requiredQuantity
  };
}

interface ResourceRequirementRow {
  resource_id: string;
  resource_title: string;
  capacity_available: number;
  mapping_quantity: string | number;
}

export async function getAvailability(query: AvailabilityQuery): Promise<AvailabilityItem[]> {
  const requirementResult = query.product_id
    ? await pool.query<ResourceRequirementRow>(
        `SELECT
           r.resource_id,
           r.title AS resource_title,
           r.capacity_available,
           pr.quantity AS mapping_quantity
         FROM product_resources pr
         INNER JOIN resources r ON r.resource_id = pr.resource_id
         WHERE pr.product_id = $1
           AND r.operational_status = 'active'
           AND ($2::uuid IS NULL OR r.location_id = $2::uuid)
         ORDER BY r.title ASC`,
        [query.product_id, query.location_id ?? null]
      )
    : await pool.query<ResourceRequirementRow>(
        `SELECT
           r.resource_id,
           r.title AS resource_title,
           r.capacity_available,
           1 AS mapping_quantity
         FROM resources r
         WHERE ($1::uuid IS NULL OR r.location_id = $1::uuid)
           AND r.operational_status = 'active'
         ORDER BY r.title ASC`,
        [query.location_id ?? null]
      );

  const resourceIds = requirementResult.rows.map((row) => row.resource_id);
  if (!resourceIds.length) {
    return [];
  }

  const reservedResult = await pool.query<{
    resource_id: string;
    capacity_available: number;
    capacity_reserved: string | number;
  }>(
    `SELECT
       r.resource_id,
       r.capacity_available,
       COALESCE(SUM(c.capacity_used), 0) AS capacity_reserved
     FROM resources r
     LEFT JOIN consumptions c
       ON c.resource_id = r.resource_id
      AND c.type IN ('reserved', 'consumed', 'blocked', 'maintenance')
      AND tstzrange(c.dt_from, c.dt_to, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)')
     WHERE r.resource_id = ANY($3::uuid[])
     GROUP BY r.resource_id, r.capacity_available`,
    [query.dt_from, query.dt_to, resourceIds]
  );

  const reservedMap = new Map(
    reservedResult.rows.map((row) => [row.resource_id, Number(row.capacity_reserved)])
  );

  const heldResult = await pool.query<{ resource_id: string; capacity_held: string | number }>(
    `SELECT allocation.resource_id, COALESCE(SUM(allocation.capacity_used), 0) AS capacity_held
     FROM reservation_hold_allocations allocation
     INNER JOIN reservation_holds hold ON hold.reservation_hold_id = allocation.reservation_hold_id
     WHERE allocation.resource_id = ANY($3::uuid[])
       AND hold.status = 'active' AND hold.expires_at > now()
       AND tstzrange(hold.starts_at, hold.ends_at, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)')
     GROUP BY allocation.resource_id`,
    [query.dt_from, query.dt_to, resourceIds]
  );
  const heldMap = new Map(heldResult.rows.map((row) => [row.resource_id, Number(row.capacity_held)]));

  return requirementResult.rows.map((row) => {
    const capacityReserved = reservedMap.get(row.resource_id) ?? 0;
    const capacityHeld = heldMap.get(row.resource_id) ?? 0;
    const snapshot = calculateAvailabilitySnapshot({
      requiredQuantity: Number(row.mapping_quantity) * query.guest_count,
      capacityAvailable: Number(row.capacity_available),
      capacityReserved: capacityReserved + capacityHeld
    });

    return {
      resource_id: row.resource_id,
      resource_title: row.resource_title,
      ...snapshot,
      capacity_reserved: capacityReserved,
      capacity_held: capacityHeld
    };
  });
}

export async function getAvailabilitySummary(query: AvailabilityQuery) {
  const resources = await getAvailability(query);
  const remaining = resources.length ? Math.min(...resources.map((item) => item.capacity_remaining)) : 0;
  const maxBookableQuantity = resources.length
    ? Math.min(...resources.map((item) => {
        const capacityPerBookingUnit = item.required_quantity / query.guest_count;
        return capacityPerBookingUnit > 0 ? Math.floor(item.capacity_remaining / capacityPerBookingUnit) : 0;
      }))
    : 0;
  return {
    available: resources.length > 0 && resources.every((item) => item.is_available),
    capacity: resources.length ? Math.min(...resources.map((item) => item.capacity_available)) : 0,
    reserved: resources.reduce((total, item) => total + item.capacity_reserved, 0),
    held: resources.reduce((total, item) => total + item.capacity_held, 0),
    remaining,
    maxBookableQuantity: Math.max(0, maxBookableQuantity),
    resources
  };
}
