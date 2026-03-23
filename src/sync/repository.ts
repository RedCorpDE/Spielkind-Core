import type { PoolClient } from 'pg';
import { pool } from '../db/client.js';
import { mapBookingForDb, mapProductForDb } from './mappers.js';
import type { RegiondoBooking, RegiondoProduct } from './types.js';

async function findOrCreateClient(client: PoolClient, regiondoCustomerId: string | null): Promise<string> {
  if (!regiondoCustomerId) {
    const inserted = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name) VALUES ('Unknown', 'Unknown') RETURNING client_id`
    );

    return inserted.rows[0].client_id;
  }

  const existing = await client.query<{ client_id: string }>(
    `SELECT client_id FROM clients WHERE regiondo_customer_id = $1 LIMIT 1`,
    [regiondoCustomerId]
  );

  if (existing.rowCount) {
    return existing.rows[0].client_id;
  }

  const inserted = await client.query<{ client_id: string }>(
    `INSERT INTO clients (first_name, last_name, regiondo_customer_id)
     VALUES ('Unknown', 'Unknown', $1)
     RETURNING client_id`,
    [regiondoCustomerId]
  );

  return inserted.rows[0].client_id;
}

async function findOrCreateLocation(client: PoolClient, regiondoLocationId: string | null): Promise<string> {
  if (!regiondoLocationId) {
    const inserted = await client.query<{ location_id: string }>(
      `INSERT INTO locations (title) VALUES ('Unknown Location') RETURNING location_id`
    );

    return inserted.rows[0].location_id;
  }

  const existing = await client.query<{ location_id: string }>(
    `SELECT location_id FROM locations WHERE regiondo_location_id = $1 LIMIT 1`,
    [regiondoLocationId]
  );

  if (existing.rowCount) {
    return existing.rows[0].location_id;
  }

  const inserted = await client.query<{ location_id: string }>(
    `INSERT INTO locations (title, regiondo_location_id)
     VALUES ('Imported Location', $1)
     RETURNING location_id`,
    [regiondoLocationId]
  );

  return inserted.rows[0].location_id;
}

export async function upsertProductWithDetails(input: RegiondoProduct): Promise<void> {
  const mapped = mapProductForDb(input);

  await pool.query(
    `INSERT INTO products (title, description, image_url, base_amount, regiondo_product_id, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   image_url = EXCLUDED.image_url,
                   base_amount = EXCLUDED.base_amount,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()`,
    [mapped.title, mapped.description, mapped.imageUrl, mapped.baseAmount, mapped.regiondoProductId, JSON.stringify(mapped.raw)]
  );

  await pool.query('DELETE FROM product_variants WHERE regiondo_product_id = $1', [mapped.regiondoProductId]);
  await pool.query('DELETE FROM product_options WHERE regiondo_product_id = $1', [mapped.regiondoProductId]);

  const variants = Array.isArray(input.variants) ? input.variants : [];
  for (const variant of variants) {
    await pool.query(
      `INSERT INTO product_variants (regiondo_variant_id, regiondo_product_id, title, price, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (regiondo_variant_id)
       DO UPDATE SET title = EXCLUDED.title,
                     price = EXCLUDED.price,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [String(variant.id), mapped.regiondoProductId, variant.title ?? null, Number(variant.price ?? 0), JSON.stringify(variant)]
    );
  }

  const options = Array.isArray(input.options) ? input.options : [];
  for (const option of options) {
    await pool.query(
      `INSERT INTO product_options (regiondo_option_id, regiondo_product_id, title, values_json, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (regiondo_option_id)
       DO UPDATE SET title = EXCLUDED.title,
                     values_json = EXCLUDED.values_json,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()`,
      [String(option.id), mapped.regiondoProductId, option.title ?? null, JSON.stringify(option.values ?? null), JSON.stringify(option)]
    );
  }
}

export async function upsertBookingFromWebhook(input: RegiondoBooking): Promise<void> {
  const mapped = mapBookingForDb(input);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const clientId = await findOrCreateClient(client, mapped.regiondoCustomerId);
    const locationId = await findOrCreateLocation(client, mapped.regiondoLocationId);

    const bookingResult = await client.query<{ booking_id: string }>(
      `INSERT INTO bookings (client_id, location_id, status, guest_count, total_amount, paid_amount, dt_from, dt_to, source, regiondo_booking_id, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'regiondo', $9, $10)
       ON CONFLICT (regiondo_booking_id)
       DO UPDATE SET client_id = EXCLUDED.client_id,
                     location_id = EXCLUDED.location_id,
                     status = EXCLUDED.status,
                     guest_count = EXCLUDED.guest_count,
                     total_amount = EXCLUDED.total_amount,
                     paid_amount = EXCLUDED.paid_amount,
                     dt_from = EXCLUDED.dt_from,
                     dt_to = EXCLUDED.dt_to,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING booking_id`,
      [
        clientId,
        locationId,
        mapped.status,
        mapped.guestCount,
        mapped.totalAmount,
        mapped.paidAmount,
        mapped.dtFrom,
        mapped.dtTo,
        mapped.regiondoBookingId,
        JSON.stringify(mapped.raw)
      ]
    );

    const bookingId = bookingResult.rows[0].booking_id;
    await client.query('DELETE FROM booking_products WHERE booking_id = $1', [bookingId]);

    for (const product of mapped.bookingProducts) {
      if (!product.id) continue;

      const existingProduct = await client.query<{ product_id: string }>(
        `SELECT product_id FROM products WHERE regiondo_product_id = $1 LIMIT 1`,
        [String(product.id)]
      );

      if (!existingProduct.rowCount) continue;

      await client.query(
        `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (booking_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       unit_price = EXCLUDED.unit_price`,
        [bookingId, existingProduct.rows[0].product_id, Number(product.quantity ?? 1), Number(product.price ?? 0)]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
