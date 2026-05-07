import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import type { NormalizedRegiondoBookingImport } from './booking-normalizer.js';

const UNKNOWN_REGIONDO_CUSTOMER_ID = '__unknown_regiondo_customer__';
const UNKNOWN_REGIONDO_LOCATION_ID = '__unknown_regiondo_location__';

async function upsertClient(client: PoolClient, input: NormalizedRegiondoBookingImport['client']): Promise<string> {
  if (input.regiondoCustomerId) {
    const result = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_customer_id, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (regiondo_customer_id)
       DO UPDATE SET first_name = EXCLUDED.first_name,
                     last_name = EXCLUDED.last_name,
                     email = COALESCE(EXCLUDED.email, clients.email),
                     phone_number = COALESCE(EXCLUDED.phone_number, clients.phone_number),
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING client_id`,
      [input.firstName, input.lastName, input.email, input.phoneNumber, input.regiondoCustomerId, JSON.stringify(input.raw)]
    );

    return result.rows[0].client_id;
  }

  if (input.email) {
    const result = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (email)
       DO UPDATE SET first_name = EXCLUDED.first_name,
                     last_name = EXCLUDED.last_name,
                     phone_number = COALESCE(EXCLUDED.phone_number, clients.phone_number),
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING client_id`,
      [input.firstName, input.lastName, input.email, input.phoneNumber, JSON.stringify(input.raw)]
    );

    return result.rows[0].client_id;
  }

  const result = await client.query<{ client_id: string }>(
    `INSERT INTO clients (first_name, last_name, regiondo_customer_id, regiondo_raw)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (regiondo_customer_id)
     DO UPDATE SET regiondo_raw = EXCLUDED.regiondo_raw, updated_at = now()
     RETURNING client_id`,
    [input.firstName, input.lastName, UNKNOWN_REGIONDO_CUSTOMER_ID, JSON.stringify(input.raw)]
  );

  return result.rows[0].client_id;
}

async function resolveLocation(
  client: PoolClient,
  input: {
    location: NormalizedRegiondoBookingImport['location'];
    regiondoProductIds: string[];
  }
): Promise<string> {
  if (input.location.regiondoLocationId) {
    const result = await client.query<{ location_id: string }>(
      `INSERT INTO locations (title, regiondo_location_id, regiondo_raw)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (regiondo_location_id)
       DO UPDATE SET title = EXCLUDED.title,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING location_id`,
      [input.location.title?.trim() || 'Imported Regiondo Location', input.location.regiondoLocationId, JSON.stringify(input.location.raw)]
    );

    return result.rows[0].location_id;
  }

  if (input.regiondoProductIds.length > 0) {
    const result = await client.query<{ location_id: string }>(
      `SELECT DISTINCT lp.location_id
       FROM location_products lp
       INNER JOIN products p ON p.product_id = lp.product_id
       WHERE p.regiondo_product_id = ANY($1::text[])
       LIMIT 2`,
      [input.regiondoProductIds]
    );

    if (result.rowCount === 1) {
      return result.rows[0].location_id;
    }
  }

  const placeholder = await client.query<{ location_id: string }>(
    `INSERT INTO locations (title, regiondo_location_id, regiondo_raw)
     VALUES ('Unknown Regiondo Location', $1, $2::jsonb)
     ON CONFLICT (regiondo_location_id)
     DO UPDATE SET regiondo_raw = EXCLUDED.regiondo_raw, updated_at = now()
     RETURNING location_id`,
    [UNKNOWN_REGIONDO_LOCATION_ID, JSON.stringify(input.location.raw)]
  );

  return placeholder.rows[0].location_id;
}

async function ensureProductStub(
  client: PoolClient,
  input: NormalizedRegiondoBookingImport['items'][number]
): Promise<string> {
  const result = await client.query<{ product_id: string }>(
    `INSERT INTO products (title, base_amount, regiondo_product_id, regiondo_raw)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = EXCLUDED.title,
                   base_amount = CASE
                     WHEN products.base_amount = 0 AND EXCLUDED.base_amount > 0 THEN EXCLUDED.base_amount
                     ELSE products.base_amount
                   END,
                   regiondo_raw = COALESCE(products.regiondo_raw, EXCLUDED.regiondo_raw),
                   updated_at = now()
     RETURNING product_id`,
    [input.title, input.unitPrice, input.regiondoProductId, JSON.stringify(input.raw)]
  );

  return result.rows[0].product_id;
}

export async function upsertNormalizedRegiondoBooking(
  client: PoolClient,
  input: NormalizedRegiondoBookingImport
): Promise<{ bookingId: string }> {
  const clientId = await upsertClient(client, input.client);
  const locationId = await resolveLocation(client, {
    location: input.location,
    regiondoProductIds: input.items.map((item) => item.regiondoProductId)
  });

  const bookingResult = await client.query<{ booking_id: string }>(
    `INSERT INTO bookings (
       client_id,
       location_id,
       status,
       guest_count,
       total_amount,
       paid_amount,
       dt_from,
       dt_to,
       source,
       regiondo_booking_id,
       regiondo_order_number,
       regiondo_snapshot_generated_at,
       regiondo_raw
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'regiondo', $9, $10, $11::timestamptz, $12::jsonb)
     ON CONFLICT (regiondo_booking_id)
     DO UPDATE SET client_id = EXCLUDED.client_id,
                   location_id = EXCLUDED.location_id,
                   status = EXCLUDED.status,
                   guest_count = EXCLUDED.guest_count,
                   total_amount = EXCLUDED.total_amount,
                   paid_amount = EXCLUDED.paid_amount,
                   dt_from = EXCLUDED.dt_from,
                   dt_to = EXCLUDED.dt_to,
                   regiondo_order_number = EXCLUDED.regiondo_order_number,
                   regiondo_snapshot_generated_at = EXCLUDED.regiondo_snapshot_generated_at,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()
     RETURNING booking_id`,
    [
      clientId,
      locationId,
      input.status,
      input.guestCount,
      input.totalAmount,
      input.paidAmount,
      input.dtFrom,
      input.dtTo,
      input.bookingKey,
      input.orderNumber,
      input.snapshotGeneratedAt,
      JSON.stringify(input.raw)
    ]
  );

  const bookingId = bookingResult.rows[0].booking_id;

  await client.query('DELETE FROM booking_products WHERE booking_id = $1', [bookingId]);

  for (const item of input.items) {
    const productId = await ensureProductStub(client, item);
    await client.query(
      `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price`,
      [bookingId, productId, item.quantity, item.unitPrice]
    );
  }

  await client.query('DELETE FROM payments WHERE booking_id = $1', [bookingId]);

  for (const payment of input.payments) {
    await client.query(
      `INSERT INTO payments (booking_id, amount, type, provider_ref)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, payment.amount, payment.type, payment.providerRef]
    );
  }

  return { bookingId };
}

export async function importNormalizedRegiondoBooking(input: NormalizedRegiondoBookingImport): Promise<{ bookingId: string }> {
  return withTransaction(async (client) => upsertNormalizedRegiondoBooking(client, input));
}

export async function listRegiondoBookingsForReconciliation(limit: number): Promise<
  Array<{ bookingId: string; bookingKey: string; orderNumber: string | null }>
> {
  const result = await pool.query<{
    booking_id: string;
    regiondo_booking_id: string;
    regiondo_order_number: string | null;
  }>(
    `SELECT booking_id, regiondo_booking_id, regiondo_order_number
     FROM bookings
     WHERE source = 'regiondo'
       AND regiondo_booking_id IS NOT NULL
       AND (
         status IN ('processing', 'unknown')
         OR regiondo_snapshot_generated_at IS NULL
       )
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    bookingId: row.booking_id,
    bookingKey: row.regiondo_booking_id,
    orderNumber: row.regiondo_order_number
  }));
}
