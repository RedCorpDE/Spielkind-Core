import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';
import type { NormalizedRegiondoBookingImport } from './booking-normalizer.js';
import { resolveBookingChangeRequests } from './booking-change-request.repository.js';
import { upsertProviderReference } from '../integrations/provider-reference.repository.js';
import { netFromGross } from '../commerce/money.js';

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
    const existing = await client.query<{ client_id: string }>(
      `SELECT client_id FROM clients WHERE LOWER(email::text) = LOWER($1) ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [input.email]
    );
    const result = existing.rowCount
      ? await client.query<{ client_id: string }>(
          `UPDATE clients
           SET first_name = $2, last_name = $3, phone_number = COALESCE($4, phone_number),
               regiondo_raw = $5::jsonb, updated_at = now()
           WHERE client_id = $1 RETURNING client_id`,
          [existing.rows[0].client_id, input.firstName, input.lastName, input.phoneNumber, JSON.stringify(input.raw)]
        )
      : await client.query<{ client_id: string }>(
          `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_raw)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING client_id`,
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
    const locationId = result.rows[0].location_id;
    await upsertProviderReference(client, {
      provider: 'regiondo', entityType: 'location', entityId: locationId,
      externalId: input.location.regiondoLocationId
    });
    return locationId;
  }

  if (input.regiondoProductIds.length > 0) {
    const result = await client.query<{ location_id: string }>(
      `SELECT DISTINCT lp.location_id
       FROM location_products lp
       INNER JOIN products p ON p.product_id = lp.product_id
       WHERE p.regiondo_product_id = ANY($1::text[])
         AND lp.enabled = true
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

async function ensureProductStub(
  client: PoolClient,
  input: NormalizedRegiondoBookingImport['items'][number]
): Promise<string> {
  const result = await client.query<{ product_id: string }>(
    `INSERT INTO products (title, base_amount, regiondo_product_id, regiondo_raw, booking_provider)
     VALUES ($1, $2, $3, $4::jsonb, 'regiondo')
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

  const productId = result.rows[0].product_id;
  await upsertProviderReference(client, {
    provider: 'regiondo', entityType: 'product', entityId: productId,
    externalId: input.regiondoProductId
  });
  return productId;
}

interface ExistingBookingOverrides {
  local_override_fields: string[] | null;
  location_override: string | null;
}

async function getExistingBookingOverrides(
  client: PoolClient,
  bookingKey: string
): Promise<ExistingBookingOverrides | null> {
  const result = await client.query<ExistingBookingOverrides>(
    `SELECT admin.local_override_fields, admin.location_override
     FROM bookings b
     LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
     WHERE b.regiondo_booking_id = $1
     LIMIT 1
     FOR UPDATE OF b`,
    [bookingKey]
  );
  return result.rowCount ? result.rows[0] : null;
}

export async function upsertNormalizedRegiondoBooking(
  client: PoolClient,
  input: NormalizedRegiondoBookingImport,
  options: { ignoreLocalOverrides?: boolean } = {}
): Promise<{ bookingId: string }> {
  const existing = options.ignoreLocalOverrides ? null : await getExistingBookingOverrides(client, input.bookingKey);
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
       booking_provider,
       regiondo_booking_id,
       regiondo_order_number,
       regiondo_snapshot_generated_at,
       regiondo_raw
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'regiondo', 'regiondo', $9, $10, $11::timestamptz, $12::jsonb)
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
      localOverrideFields.has('location'),
      localOverrideFields.has('attendees'),
      localOverrideFields.has('payment'),
      localOverrideFields.has('schedule')
    ]
  );

  const bookingId = bookingResult.rows[0].booking_id;

  await upsertProviderReference(client, {
    provider: 'regiondo',
    entityType: 'booking',
    entityId: bookingId,
    externalId: input.bookingKey,
    externalParentId: input.orderNumber
  });

  if (!localOverrideFields.has('products')) {
    await client.query('DELETE FROM booking_products WHERE booking_id = $1', [bookingId]);
    await client.query('DELETE FROM booking_items WHERE booking_id = $1', [bookingId]);

    for (const item of input.items) {
      const productId = await ensureProductStub(client, item);
      await client.query(
        `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (booking_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price`,
        [bookingId, productId, item.quantity, item.unitPrice]
      );
      const productResult = await client.query<{ vat_basis_points: number; currency: string }>(
        `SELECT vat_basis_points, currency FROM products WHERE product_id = $1`,
        [productId]
      );
      const vatBasisPoints = Number(productResult.rows[0]?.vat_basis_points ?? 1900);
      const currency = productResult.rows[0]?.currency ?? 'EUR';
      const unitGross = Math.round(item.unitPrice * 100);
      const subtotalGross = unitGross * item.quantity;
      const subtotalNet = netFromGross(subtotalGross, vatBasisPoints);
      await client.query(
        `INSERT INTO booking_items (
           booking_id, product_id, quantity, product_name_snapshot,
           unit_price_net, unit_price_gross, vat_basis_points,
           subtotal_net, tax_amount, subtotal_gross, currency, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          bookingId, productId, item.quantity, item.title,
          netFromGross(unitGross, vatBasisPoints), unitGross, vatBasisPoints,
          subtotalNet, subtotalGross - subtotalNet, subtotalGross, currency,
          JSON.stringify({ provider: 'regiondo', externalProductId: item.regiondoProductId })
        ]
      );
    }
  }

  if (!localOverrideFields.has('payment')) {
    await client.query('DELETE FROM payments WHERE booking_id = $1', [bookingId]);

    for (const payment of input.payments) {
      await client.query(
        `INSERT INTO payments (
           booking_id, amount, type, provider_ref, provider, status,
           amount_minor, currency, provider_payment_id
         ) VALUES ($1, $2, $3, $4, 'regiondo', 'succeeded', $5, 'EUR', $4)`,
        [bookingId, payment.amount, payment.type, payment.providerRef, Math.round(payment.amount * 100)]
      );
    }
  }

  await resolveBookingChangeRequests({
    client,
    bookingId,
    providerValues: {
      attendees: input.guestCount,
      schedule: { bookingDate: input.dtFrom, bookingEndDate: input.dtTo },
      contact: {
        firstName: input.client.firstName,
        lastName: input.client.lastName,
        email: input.client.email,
        phoneNumber: input.client.phoneNumber
      },
      payment: { amountToPay: input.totalAmount, amountPaid: input.paidAmount },
      products: input.items.map((item) => ({ productId: item.regiondoProductId, quantity: item.quantity, unitPrice: item.unitPrice })),
      location: input.location.regiondoLocationId
    }
  });

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
