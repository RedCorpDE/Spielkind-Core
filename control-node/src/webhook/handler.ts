import { query } from "../db/client.js";
import { mapCustomer, mapProduct, mapBooking } from "../sync/mappers.js";

export type RegionodoEventType =
    | "booking.created"
    | "booking.updated"
    | "booking.cancelled"
    | "booking.confirmed"
    | "booking.completed"
    | "customer.created"
    | "customer.updated"
    | "product.created"
    | "product.updated"
    | (string & {}); // allow unknown events without breaking the type

export interface WebhookPayload {
    event: RegionodoEventType;
    data: Record<string, unknown>;
    timestamp?: string;
}

// ─── DB helpers (mirror of sync-service, but single-record) ──────────────────

async function upsertClientFromWebhook(
    raw: Record<string, unknown>
): Promise<void> {
    const c = mapCustomer(raw);
    await query(
        `INSERT INTO clients (regiondo_customer_id, first_name, last_name, email, phone_number, birthday, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (regiondo_customer_id) DO UPDATE SET
       first_name    = EXCLUDED.first_name,
       last_name     = EXCLUDED.last_name,
       email         = EXCLUDED.email,
       phone_number  = EXCLUDED.phone_number,
       birthday      = EXCLUDED.birthday,
       regiondo_raw  = EXCLUDED.regiondo_raw`,
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
    console.log(`[Webhook] Upserted client ${c.regiondo_customer_id}`);
}

async function upsertProductFromWebhook(
    raw: Record<string, unknown>
): Promise<void> {
    const p = mapProduct(raw);
    await query(
        `INSERT INTO products (regiondo_product_id, title, description, base_amount, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (regiondo_product_id) DO UPDATE SET
       title         = EXCLUDED.title,
       description   = EXCLUDED.description,
       base_amount   = EXCLUDED.base_amount,
       regiondo_raw  = EXCLUDED.regiondo_raw`,
        [
            p.regiondo_product_id,
            p.title,
            p.description,
            p.base_amount,
            JSON.stringify(p.regiondo_raw),
        ]
    );
    console.log(`[Webhook] Upserted product ${p.regiondo_product_id}`);
}

async function upsertBookingFromWebhook(
    raw: Record<string, unknown>
): Promise<void> {
    const b = mapBooking(raw);

    // Resolve client_id — auto-upsert the embedded customer if present
    const embeddedCustomer =
        typeof raw.customer === "object" && raw.customer !== null
            ? (raw.customer as Record<string, unknown>)
            : null;

    if (embeddedCustomer) {
        await upsertClientFromWebhook(embeddedCustomer);
    }

    const clients = await query<{ client_id: string }>(
        `SELECT client_id FROM clients WHERE regiondo_customer_id = $1`,
        [b.regiondo_customer_id]
    );

    if (clients.length === 0) {
        console.warn(
            `[Webhook] Skipping booking ${b.regiondo_booking_id}: ` +
            `client ${b.regiondo_customer_id} not found`
        );
        return;
    }

    const clientId = clients[0].client_id;

    const locations = await query<{ location_id: string }>(
        `SELECT location_id FROM locations LIMIT 1`
    );

    if (locations.length === 0) {
        console.warn(
            `[Webhook] Skipping booking ${b.regiondo_booking_id}: no locations exist yet`
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
       dt_from       = EXCLUDED.dt_from,
       dt_to         = EXCLUDED.dt_to,
       guest_count   = EXCLUDED.guest_count,
       total_amount  = EXCLUDED.total_amount,
       paid_amount   = EXCLUDED.paid_amount,
       status        = EXCLUDED.status,
       regiondo_raw  = EXCLUDED.regiondo_raw`,
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
    console.log(`[Webhook] Upserted booking ${b.regiondo_booking_id} (${b.status})`);
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function handleWebhookEvent(payload: WebhookPayload): Promise<void> {
    const { event, data } = payload;
    console.log(`[Webhook] Received event: ${event}`);

    switch (event) {
        case "booking.created":
        case "booking.updated":
        case "booking.confirmed":
        case "booking.completed":
        case "booking.cancelled":
            await upsertBookingFromWebhook(data);
            break;

        case "customer.created":
        case "customer.updated":
            await upsertClientFromWebhook(data);
            break;

        case "product.created":
        case "product.updated":
            await upsertProductFromWebhook(data);
            break;

        default:
            console.warn(`[Webhook] Unhandled event type: ${event}`);
    }
}