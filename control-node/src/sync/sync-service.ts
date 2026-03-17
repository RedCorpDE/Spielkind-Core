import { query, pool } from "../db/client.js";
import { fetchCustomers, fetchProducts, fetchBookings } from "./regiondo-api.js";
import {
  mapCustomer,
  mapProduct,
  mapBooking,
  type ClientUpsert,
  type ProductUpsert,
  type BookingUpsert,
} from "./mappers.js";

async function getLastSyncTime(syncType: string): Promise<string | null> {
  const rows = await query<{ completed_at: string }>(
    `SELECT completed_at FROM sync_log
     WHERE sync_type = $1 AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 1`,
    [syncType]
  );
  return rows[0]?.completed_at ?? null;
}

async function logSyncStart(syncType: string): Promise<string> {
  const rows = await query<{ sync_id: string }>(
    `INSERT INTO sync_log (sync_type, status)
     VALUES ($1, 'started')
     RETURNING sync_id`,
    [syncType]
  );
  return rows[0].sync_id;
}

async function logSyncComplete(
  syncId: string,
  recordsSynced: number
): Promise<void> {
  await query(
    `UPDATE sync_log
     SET status = 'completed', records_synced = $2, completed_at = now()
     WHERE sync_id = $1`,
    [syncId, recordsSynced]
  );
}

async function logSyncFailed(
  syncId: string,
  errorMessage: string
): Promise<void> {
  await query(
    `UPDATE sync_log
     SET status = 'failed', error_message = $2, completed_at = now()
     WHERE sync_id = $1`,
    [syncId, errorMessage]
  );
}

async function upsertClient(c: ClientUpsert): Promise<void> {
  await query(
    `INSERT INTO clients (regiondo_customer_id, first_name, last_name, email, phone_number, birthday, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (regiondo_customer_id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       email = EXCLUDED.email,
       phone_number = EXCLUDED.phone_number,
       birthday = EXCLUDED.birthday,
       regiondo_raw = EXCLUDED.regiondo_raw`,
    [
      c.regiondo_customer_id,
      c.first_name,
      c.last_name,
      c.email,
      c.phone_number,
      c.birthday,
      JSON.stringify(c.regiondo_raw),
    ]
  );
}

async function upsertProduct(p: ProductUpsert): Promise<void> {
  await query(
    `INSERT INTO products (regiondo_product_id, title, description, base_amount, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (regiondo_product_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       base_amount = EXCLUDED.base_amount,
       regiondo_raw = EXCLUDED.regiondo_raw`,
    [
      p.regiondo_product_id,
      p.title,
      p.description,
      p.base_amount,
      JSON.stringify(p.regiondo_raw),
    ]
  );
}

async function upsertBooking(b: BookingUpsert): Promise<void> {
  // Resolve client_id from regiondo_customer_id
  const clients = await query<{ client_id: string }>(
    `SELECT client_id FROM clients WHERE regiondo_customer_id = $1`,
    [b.regiondo_customer_id]
  );

  if (clients.length === 0) {
    console.warn(
      `[Sync] Skipping booking ${b.regiondo_booking_id}: client ${b.regiondo_customer_id} not found`
    );
    return;
  }

  const clientId = clients[0].client_id;

  // For location_id we use the first available location (to be refined later)
  const locations = await query<{ location_id: string }>(
    `SELECT location_id FROM locations LIMIT 1`
  );

  if (locations.length === 0) {
    console.warn(
      `[Sync] Skipping booking ${b.regiondo_booking_id}: no locations exist yet`
    );
    return;
  }

  const locationId = locations[0].location_id;

  await query(
    `INSERT INTO bookings (
       regiondo_booking_id, client_id, location_id,
       dt_from, dt_to, guest_count, total_amount, paid_amount,
       status, source, regiondo_raw
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'regiondo', $10)
     ON CONFLICT (regiondo_booking_id) DO UPDATE SET
       dt_from = EXCLUDED.dt_from,
       dt_to = EXCLUDED.dt_to,
       guest_count = EXCLUDED.guest_count,
       total_amount = EXCLUDED.total_amount,
       paid_amount = EXCLUDED.paid_amount,
       status = EXCLUDED.status,
       regiondo_raw = EXCLUDED.regiondo_raw`,
    [
      b.regiondo_booking_id,
      clientId,
      locationId,
      b.dt_from,
      b.dt_to,
      b.guest_count,
      b.total_amount,
      b.paid_amount,
      b.status,
      JSON.stringify(b.regiondo_raw),
    ]
  );
}

export async function syncCustomers(
  updatedSince?: string | null
): Promise<number> {
  const syncId = await logSyncStart("customers");
  try {
    const params: Record<string, string> = {};
    if (updatedSince) params.updated_since = updatedSince;

    const rawCustomers = await fetchCustomers(params);
    let count = 0;

    for (const raw of rawCustomers) {
      const mapped = mapCustomer(raw as Record<string, unknown>);
      await upsertClient(mapped);
      count++;
    }

    await logSyncComplete(syncId, count);
    console.log(`[Sync] Customers: ${count} synced`);
    return count;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSyncFailed(syncId, msg);
    console.error("[Sync] Customers failed:", msg);
    throw err;
  }
}

export async function syncProducts(
  updatedSince?: string | null
): Promise<number> {
  const syncId = await logSyncStart("products");
  try {
    const params: Record<string, string> = {};
    if (updatedSince) params.updated_since = updatedSince;

    const rawProducts = await fetchProducts(params);
    let count = 0;

    for (const raw of rawProducts) {
      const mapped = mapProduct(raw as Record<string, unknown>);
      await upsertProduct(mapped);
      count++;
    }

    await logSyncComplete(syncId, count);
    console.log(`[Sync] Products: ${count} synced`);
    return count;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSyncFailed(syncId, msg);
    console.error("[Sync] Products failed:", msg);
    throw err;
  }
}

export async function syncBookings(
  updatedSince?: string | null
): Promise<number> {
  const syncId = await logSyncStart("bookings");
  try {
    const params: Record<string, string> = {};
    if (updatedSince) params.updated_since = updatedSince;

    const rawBookings = await fetchBookings(params);
    let count = 0;

    for (const raw of rawBookings) {
      const mapped = mapBooking(raw as Record<string, unknown>);
      await upsertBooking(mapped);
      count++;
    }

    await logSyncComplete(syncId, count);
    console.log(`[Sync] Bookings: ${count} synced`);
    return count;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSyncFailed(syncId, msg);
    console.error("[Sync] Bookings failed:", msg);
    throw err;
  }
}

export async function runIncrementalSync(): Promise<void> {
  console.log(`[Sync] Starting incremental sync at ${new Date().toISOString()}`);

  const customersSince = await getLastSyncTime("customers");
  const productsSince = await getLastSyncTime("products");
  const bookingsSince = await getLastSyncTime("bookings");

  //await syncCustomers(customersSince);
  //await syncProducts(productsSince);
  await syncBookings(bookingsSince);

  console.log("[Sync] Incremental sync complete.");
}
