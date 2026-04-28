import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';

export class OverbookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverbookingError';
  }
}

export class MissingProductResourceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingProductResourceMappingError';
  }
}

interface ResourceRequirementRow {
  resource_id: string;
  resource_title: string;
  capacity_available: number;
  required_quantity: string | number;
}

export async function rebuildConsumptionsForBooking(bookingId: string): Promise<{
  bookingId: string;
  released: boolean;
  consumptionsCreated: number;
}> {
  return withTransaction(
    async (client) => {
      const bookingResult = await client.query<{
        booking_id: string;
        status: string;
        dt_from: string;
        dt_to: string;
      }>(
        `SELECT booking_id, status, dt_from, dt_to
         FROM bookings
         WHERE booking_id = $1
         FOR UPDATE`,
        [bookingId]
      );

      if (!bookingResult.rowCount) {
        throw new Error(`Booking ${bookingId} not found.`);
      }

      const booking = bookingResult.rows[0];

      const bookingProductsResult = await client.query<{ product_count: string | number }>(
        `SELECT COUNT(*) AS product_count
         FROM booking_products
         WHERE booking_id = $1`,
        [bookingId]
      );

      const requirementResult = await client.query<ResourceRequirementRow>(
        `SELECT
           r.resource_id,
           r.title AS resource_title,
           r.capacity_available,
           SUM(bp.quantity * pr.quantity) AS required_quantity
         FROM booking_products bp
         INNER JOIN product_resources pr ON pr.product_id = bp.product_id
         INNER JOIN resources r ON r.resource_id = pr.resource_id
         WHERE bp.booking_id = $1
         GROUP BY r.resource_id, r.title, r.capacity_available
         ORDER BY r.resource_id`,
        [bookingId]
      );

      await client.query(
        `DELETE FROM consumptions
         WHERE booking_id = $1
           AND dt_to > now()`,
        [bookingId]
      );

      if (booking.status === 'canceled' || booking.status === 'rejected') {
        return {
          bookingId,
          released: true,
          consumptionsCreated: 0
        };
      }

      const hasProducts = Number(bookingProductsResult.rows[0]?.product_count ?? 0) > 0;
      if (hasProducts && requirementResult.rows.length === 0) {
        throw new MissingProductResourceMappingError(
          `Booking ${bookingId} cannot rebuild consumptions because its products are not mapped to internal resources.`
        );
      }

      const resourceIds = requirementResult.rows.map((row) => row.resource_id);
      if (!resourceIds.length) {
        return {
          bookingId,
          released: false,
          consumptionsCreated: 0
        };
      }

      await client.query(
        `SELECT resource_id
         FROM resources
         WHERE resource_id = ANY($1::uuid[])
         ORDER BY resource_id
         FOR UPDATE`,
        [resourceIds]
      );

      const reservedResult = await client.query<{
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
        [booking.dt_from, booking.dt_to, resourceIds]
      );

      const reservedMap = new Map(
        reservedResult.rows.map((row) => [row.resource_id, Number(row.capacity_reserved)])
      );

      for (const requirement of requirementResult.rows) {
        const requiredQuantity = Number(requirement.required_quantity);
        const capacityAvailable = Number(requirement.capacity_available);
        const capacityReserved = reservedMap.get(requirement.resource_id) ?? 0;

        if (capacityReserved + requiredQuantity > capacityAvailable) {
          throw new OverbookingError(
            `Booking ${bookingId} would overbook resource ${requirement.resource_title} (${requirement.resource_id}).`
          );
        }
      }

      for (const requirement of requirementResult.rows) {
        await client.query(
          `INSERT INTO consumptions (booking_id, resource_id, type, dt_from, dt_to, capacity_used)
           VALUES ($1, $2, 'reserved', $3::timestamptz, $4::timestamptz, $5)`,
          [bookingId, requirement.resource_id, booking.dt_from, booking.dt_to, Number(requirement.required_quantity)]
        );
      }

      return {
        bookingId,
        released: false,
        consumptionsCreated: requirementResult.rows.length
      };
    },
    { isolationLevel: 'SERIALIZABLE' }
  );
}

export async function releaseConsumptionsForBooking(bookingId: string): Promise<void> {
  await pool.query(
    `DELETE FROM consumptions
     WHERE booking_id = $1
       AND dt_to > now()`,
    [bookingId]
  );
}
