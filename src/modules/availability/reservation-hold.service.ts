import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { HoldExpiredError, InsufficientCapacityError } from '../bookings/booking.errors.js';
import { MissingProductResourceMappingError } from '../resources/consumption.service.js';

export interface CreateReservationHoldInput {
  clientId?: string;
  locationId: string;
  productId: string;
  productVariantId?: string;
  quantity: number;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ReservationHold {
  id: string;
  status: 'active' | 'consumed' | 'expired' | 'released';
  expiresAt: string;
  allocations: Array<{ resourceId: string; capacityUsed: number }>;
}

interface RequirementRow {
  resource_id: string;
  title: string;
  capacity_available: number;
  required_quantity: string | number;
}

export function isReservationHoldCapacityActive(
  status: ReservationHold['status'],
  expiresAt: string,
  now = new Date().toISOString()
): boolean {
  return status === 'active' && new Date(expiresAt).getTime() > new Date(now).getTime();
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '40001';
}

async function withSerializableRetry<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(work, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new Error('Unreachable serializable transaction state.');
}

async function loadHold(client: PoolClient, holdId: string): Promise<ReservationHold> {
  const result = await client.query<{
    reservation_hold_id: string; status: ReservationHold['status']; expires_at: string;
  }>(`SELECT reservation_hold_id, status, expires_at FROM reservation_holds WHERE reservation_hold_id = $1`, [holdId]);
  if (!result.rowCount) throw new Error(`Reservation hold ${holdId} was not found.`);
  const allocations = await client.query<{ resource_id: string; capacity_used: number }>(
    `SELECT resource_id, capacity_used FROM reservation_hold_allocations WHERE reservation_hold_id = $1 ORDER BY resource_id`,
    [holdId]
  );
  return {
    id: result.rows[0].reservation_hold_id,
    status: result.rows[0].status,
    expiresAt: result.rows[0].expires_at,
    allocations: allocations.rows.map((row) => ({ resourceId: row.resource_id, capacityUsed: row.capacity_used }))
  };
}

export async function createReservationHold(input: CreateReservationHoldInput): Promise<ReservationHold> {
  return withSerializableRetry(async (client) => {
    const existing = await client.query<{ reservation_hold_id: string }>(
      `SELECT reservation_hold_id FROM reservation_holds WHERE idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (existing.rowCount) return loadHold(client, existing.rows[0].reservation_hold_id);

    const requirements = await client.query<RequirementRow>(
      `SELECT r.resource_id, r.title, r.capacity_available,
              (pr.quantity * $3::integer) AS required_quantity
       FROM product_resources pr
       INNER JOIN resources r ON r.resource_id = pr.resource_id
       WHERE pr.product_id = $1 AND r.location_id = $2 AND r.operational_status = 'active'
       ORDER BY r.resource_id`,
      [input.productId, input.locationId, input.quantity]
    );
    if (!requirements.rowCount) {
      throw new MissingProductResourceMappingError('Product has no active resource capacity mapping at this location.');
    }

    const resourceIds = requirements.rows.map((row) => row.resource_id);
    await client.query(
      `SELECT resource_id FROM resources WHERE resource_id = ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE`,
      [resourceIds]
    );

    for (const requirement of requirements.rows) {
      const usage = await client.query<{ used: string | number }>(
        `SELECT
           COALESCE((SELECT SUM(c.capacity_used) FROM consumptions c
             WHERE c.resource_id = $1
               AND c.type IN ('reserved', 'consumed', 'blocked', 'maintenance')
               AND tstzrange(c.dt_from, c.dt_to, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')), 0)
           + COALESCE((SELECT SUM(allocation.capacity_used)
             FROM reservation_hold_allocations allocation
             INNER JOIN reservation_holds hold ON hold.reservation_hold_id = allocation.reservation_hold_id
             WHERE allocation.resource_id = $1 AND hold.status = 'active' AND hold.expires_at > now()
               AND tstzrange(hold.starts_at, hold.ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')), 0) AS used`,
        [requirement.resource_id, input.startsAt, input.endsAt]
      );
      const required = Number(requirement.required_quantity);
      if (Number(usage.rows[0]?.used ?? 0) + required > Number(requirement.capacity_available)) {
        throw new InsufficientCapacityError(`Resource ${requirement.title} does not have enough remaining capacity.`);
      }
    }

    const hold = await client.query<{ reservation_hold_id: string }>(
      `INSERT INTO reservation_holds (
         client_id, location_id, product_id, product_variant_id, quantity,
         starts_at, ends_at, expires_at, status, idempotency_key, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, 'active', $9, $10::jsonb)
       RETURNING reservation_hold_id`,
      [
        input.clientId ?? null, input.locationId, input.productId, input.productVariantId ?? null,
        input.quantity, input.startsAt, input.endsAt, input.expiresAt, input.idempotencyKey,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const holdId = hold.rows[0].reservation_hold_id;
    for (const requirement of requirements.rows) {
      await client.query(
        `INSERT INTO reservation_hold_allocations (reservation_hold_id, resource_id, capacity_used) VALUES ($1, $2, $3)`,
        [holdId, requirement.resource_id, Number(requirement.required_quantity)]
      );
    }
    return loadHold(client, holdId);
  });
}

export async function expireReservationHolds(limit = 500): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query<{ booking_id: string | null }>(
    `WITH expiring AS (
       SELECT reservation_hold_id FROM reservation_holds
       WHERE status = 'active' AND expires_at <= now()
       ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE reservation_holds hold SET status = 'expired', updated_at = now()
     FROM expiring WHERE hold.reservation_hold_id = expiring.reservation_hold_id
     RETURNING hold.booking_id`,
    [limit]
    );
    const bookingIds = result.rows.flatMap((row) => row.booking_id ? [row.booking_id] : []);
    if (bookingIds.length) {
      await client.query(
        `UPDATE bookings SET status = 'expired', payment_status = CASE
           WHEN payment_status IN ('unpaid', 'processing', 'failed') THEN 'failed' ELSE payment_status END,
           updated_at = now()
         WHERE booking_id = ANY($1::uuid[]) AND status IN ('held', 'pending', 'payment_pending', 'payment_failed')`,
        [bookingIds]
      );
      await client.query(
        `UPDATE payments SET status = 'cancelled', updated_at = now()
         WHERE booking_id = ANY($1::uuid[]) AND status IN ('requires_payment', 'processing')`,
        [bookingIds]
      );
    }
    return result.rowCount ?? 0;
  });
}

export async function releaseReservationHold(holdId: string, clientId?: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE reservation_holds SET status = 'released', updated_at = now()
     WHERE reservation_hold_id = $1 AND status = 'active'
       AND ($2::uuid IS NULL OR client_id = $2::uuid)`,
    [holdId, clientId ?? null]
  );
  return Boolean(result.rowCount);
}

export async function consumeReservationHold(client: PoolClient, holdId: string, bookingId: string): Promise<void> {
  const result = await client.query<{ status: string; expires_at: string }>(
    `SELECT status, expires_at FROM reservation_holds WHERE reservation_hold_id = $1 FOR UPDATE`,
    [holdId]
  );
  if (!result.rowCount || result.rows[0].status !== 'active' || new Date(result.rows[0].expires_at).getTime() <= Date.now()) {
    throw new HoldExpiredError();
  }
  await client.query(
    `UPDATE reservation_holds SET status = 'consumed', booking_id = $2, updated_at = now() WHERE reservation_hold_id = $1`,
    [holdId, bookingId]
  );
}

export async function attachReservationHold(client: PoolClient, holdId: string, bookingId: string): Promise<void> {
  const result = await client.query<{ status: string; expires_at: string }>(
    `SELECT status, expires_at FROM reservation_holds WHERE reservation_hold_id = $1 FOR UPDATE`,
    [holdId]
  );
  if (!result.rowCount || result.rows[0].status !== 'active' || new Date(result.rows[0].expires_at).getTime() <= Date.now()) {
    throw new HoldExpiredError();
  }
  await client.query(
    `UPDATE reservation_holds SET booking_id = $2, updated_at = now() WHERE reservation_hold_id = $1`,
    [holdId, bookingId]
  );
}

