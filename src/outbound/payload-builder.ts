import { pool } from '../db/client.js';
import { appConfig } from '../config.js';
import type { BookingRow, ClientMessagePayload, CheckOutPayload, TriggerType } from './types.js';

/**
 * Fetches bookings whose dt_from falls within [windowStart, windowEnd].
 * Joins clients for contact data and resolves group_name from client_groups (best-effort).
 * No PII is logged -- only booking IDs.
 */
export async function fetchBookingsInWindow(
  windowStart: Date,
  windowEnd: Date
): Promise<BookingRow[]> {
  const result = await pool.query<BookingRow>(
    `SELECT
       b.booking_id,
       c.first_name,
       c.last_name,
       c.preferred_contact_type,
       b.guest_count,
       b.dt_from,
       b.dt_to,
       -- group_name: first group the client belongs to, nullable
       (
         SELECT cg.title
         FROM client_group_members cgm
         JOIN client_groups cg ON cg.group_id = cgm.group_id
         WHERE cgm.client_id = c.client_id
         ORDER BY cgm.joined_at
         LIMIT 1
       ) AS group_name,
       -- booking_type: title of the first booked product, nullable
       (
         SELECT p.title
         FROM booking_products bp
         JOIN products p ON p.product_id = bp.product_id
         WHERE bp.booking_id = b.booking_id
         ORDER BY p.title
         LIMIT 1
       ) AS booking_type
     FROM bookings b
     JOIN clients c ON c.client_id = b.client_id
     WHERE b.dt_from >= $1
       AND b.dt_from <= $2
       AND b.status NOT IN ('cancelled', 'no_show')
     ORDER BY b.dt_from`,
    [windowStart.toISOString(), windowEnd.toISOString()]
  );
  return result.rows;
}

/**
 * Fetches bookings whose check-out time (dt_to) falls within [windowStart, windowEnd].
 * Used for T4 (check-out trigger).
 */
export async function fetchBookingsByCheckOut(
  windowStart: Date,
  windowEnd: Date
): Promise<BookingRow[]> {
  const result = await pool.query<BookingRow>(
    `SELECT
       b.booking_id,
       c.first_name,
       c.last_name,
       c.preferred_contact_type,
       b.guest_count,
       b.dt_from,
       b.dt_to,
       (
         SELECT cg.title
         FROM client_group_members cgm
         JOIN client_groups cg ON cg.group_id = cgm.group_id
         WHERE cgm.client_id = c.client_id
         ORDER BY cgm.joined_at
         LIMIT 1
       ) AS group_name,
       (
         SELECT p.title
         FROM booking_products bp
         JOIN products p ON p.product_id = bp.product_id
         WHERE bp.booking_id = b.booking_id
         ORDER BY p.title
         LIMIT 1
       ) AS booking_type
     FROM bookings b
     JOIN clients c ON c.client_id = b.client_id
     WHERE b.dt_to >= $1
       AND b.dt_to <= $2
       AND b.status NOT IN ('cancelled', 'no_show')
     ORDER BY b.dt_to`,
    [windowStart.toISOString(), windowEnd.toISOString()]
  );
  return result.rows;
}

export function buildClientMessagePayload(
  row: BookingRow,
  type: 'client_message_7d' | 'client_message_1d'
): ClientMessagePayload {
  return {
    type,
    bookingId: row.booking_id,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredContactType: row.preferred_contact_type,
    groupName: row.group_name,
    groupSize: row.guest_count,
    eventDateTime: row.dt_from instanceof Date
      ? row.dt_from.toISOString()
      : new Date(row.dt_from).toISOString(),
    bookingType: row.booking_type,
  };
}

export function buildCheckOutPayload(row: BookingRow): CheckOutPayload {
  return {
    type: 'check_out',
    bookingId: row.booking_id,
    firstName: row.first_name,
    lastName: row.last_name,
    groupName: row.group_name,
    groupSize: row.guest_count,
    // attendee_names: not stored in DB schema; always null for now
    attendeeNames: null,
    eventDateTime: row.dt_from instanceof Date
      ? row.dt_from.toISOString()
      : new Date(row.dt_from).toISOString(),
    bookingType: row.booking_type,
    agentGeneratedGoodbye: appConfig.CHECKOUT_GOODBYE_TEXT,
  };
}

/**
 * Checks whether the outbound_log already has a successful 'sent' entry
 * for this booking + trigger combination (idempotency guard).
 */
export async function isAlreadySent(bookingId: string, triggerType: TriggerType): Promise<boolean> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM outbound_log WHERE booking_id = $1 AND trigger_type = $2 LIMIT 1`,
    [bookingId, triggerType]
  );
  if (!result.rowCount) return false;
  return result.rows[0].status === 'sent';
}

/**
 * Upserts an outbound_log entry. Creates it on first attempt, updates on retry.
 */
export async function upsertOutboundLog(
  bookingId: string,
  triggerType: TriggerType,
  scheduledAt: Date,
  status: 'pending' | 'sent' | 'failed',
  attempts: number,
  lastError: string | null,
  sentAt: Date | null
): Promise<void> {
  await pool.query(
    `INSERT INTO outbound_log (booking_id, trigger_type, scheduled_at, sent_at, status, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (booking_id, trigger_type)
     DO UPDATE SET
       status = EXCLUDED.status,
       attempts = EXCLUDED.attempts,
       last_error = EXCLUDED.last_error,
       sent_at = EXCLUDED.sent_at,
       scheduled_at = LEAST(outbound_log.scheduled_at, EXCLUDED.scheduled_at)`,
    [bookingId, triggerType, scheduledAt.toISOString(), sentAt?.toISOString() ?? null, status, attempts, lastError]
  );
}
