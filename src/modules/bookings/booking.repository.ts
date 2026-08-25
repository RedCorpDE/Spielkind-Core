import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';
import type { NormalizedRegiondoBookingImport } from './booking-normalizer.js';

async function upsertClient(client: PoolClient, input: NormalizedRegiondoBookingImport['client']): Promise<string> {
  if (input.regiondoCustomerId) {
    const result = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_customer_id, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (regiondo_customer_id)
       DO UPDATE SET first_name = CASE WHEN 'first_name' = ANY(clients.local_override_fields) THEN clients.first_name ELSE EXCLUDED.first_name END,
                     last_name = CASE WHEN 'last_name' = ANY(clients.local_override_fields) THEN clients.last_name ELSE EXCLUDED.last_name END,
                     email = CASE WHEN 'email' = ANY(clients.local_override_fields) THEN clients.email ELSE COALESCE(EXCLUDED.email, clients.email) END,
                     phone_number = CASE WHEN 'phone_number' = ANY(clients.local_override_fields) THEN clients.phone_number ELSE COALESCE(EXCLUDED.phone_number, clients.phone_number) END,
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
       DO UPDATE SET first_name = CASE WHEN 'first_name' = ANY(clients.local_override_fields) THEN clients.first_name ELSE EXCLUDED.first_name END,
                     last_name = CASE WHEN 'last_name' = ANY(clients.local_override_fields) THEN clients.last_name ELSE EXCLUDED.last_name END,
                     phone_number = CASE WHEN 'phone_number' = ANY(clients.local_override_fields) THEN clients.phone_number ELSE COALESCE(EXCLUDED.phone_number, clients.phone_number) END,
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
    [input.firstName, input.lastName, SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID, JSON.stringify(input.raw)]
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
    [SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID, JSON.stringify(input.location.raw)]
  );

  return placeholder.rows[0].location_id;
}

async function resolveNoLocationPlaceholder(client: PoolClient): Promise<string> {
  const result = await client.query<{ location_id: string }>(
    `INSERT INTO locations (title, description, regiondo_location_id, regiondo_raw)
     VALUES ('No location', NULL, $1, $2::jsonb)
     ON CONFLICT (regiondo_location_id)
     DO UPDATE SET title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()
     RETURNING location_id`,
    [SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID, JSON.stringify({ source: 'system', kind: 'no_location' })]
  );

  return result.rows[0].location_id;
}

interface ExistingBookingOverrides {
  booking_id: string;
  client_id: string;
  local_override_fields: string[] | null;
  location_override: string | null;
}

async function getExistingBookingOverrides(client: PoolClient, bookingKey: string): Promise<ExistingBookingOverrides | null> {
  const result = await client.query<ExistingBookingOverrides>(
    `SELECT b.booking_id, b.client_id, admin.local_override_fields, admin.location_override
     FROM bookings b
     LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
     WHERE b.regiondo_booking_id = $1
     LIMIT 1
     FOR UPDATE OF b`,
    [bookingKey]
  );

  return result.rows[0] ?? null;
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
  const existing = await getExistingBookingOverrides(client, input.bookingKey);
  const localOverrideFields = new Set(existing?.local_override_fields ?? []);
  const clientId = await upsertClient(client, input.client);
  const providerLocationId = await resolveLocation(client, {
    location: input.location,
    regiondoProductIds: input.items.map((item) => item.regiondoProductId)
  });
  const locationId = existing?.location_override === 'none'
    ? await resolveNoLocationPlaceholder(client)
    : providerLocationId;

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
     DO UPDATE SET client_id = CASE WHEN $13::boolean THEN bookings.client_id ELSE EXCLUDED.client_id END,
                   location_id = CASE WHEN $14::boolean THEN bookings.location_id ELSE EXCLUDED.location_id END,
                   status = EXCLUDED.status,
                   guest_count = CASE WHEN $15::boolean THEN bookings.guest_count ELSE EXCLUDED.guest_count END,
                   total_amount = CASE WHEN $16::boolean THEN bookings.total_amount ELSE EXCLUDED.total_amount END,
                   paid_amount = CASE WHEN $16::boolean THEN bookings.paid_amount ELSE EXCLUDED.paid_amount END,
                   dt_from = CASE WHEN $17::boolean THEN bookings.dt_from ELSE EXCLUDED.dt_from END,
                   dt_to = CASE WHEN $17::boolean THEN bookings.dt_to ELSE EXCLUDED.dt_to END,
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
      JSON.stringify(input.raw),
      localOverrideFields.has('contact'),
      localOverrideFields.has('location') || existing?.location_override === 'none',
      localOverrideFields.has('attendees'),
      localOverrideFields.has('payment'),
      localOverrideFields.has('schedule')
    ]
  );

  const bookingId = bookingResult.rows[0].booking_id;

  if (!localOverrideFields.has('products')) {
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
  }

  if (!localOverrideFields.has('payment')) {
    await client.query('DELETE FROM payments WHERE booking_id = $1', [bookingId]);

    for (const payment of input.payments) {
      await client.query(
        `INSERT INTO payments (booking_id, amount, type, provider_ref)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, payment.amount, payment.type, payment.providerRef]
      );
    }
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
