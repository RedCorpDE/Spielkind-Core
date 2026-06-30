import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { pool } from '../db/client.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID,
  aggregateBookingStatus,
  calculateBookingRange,
  extractLegacyCustomerId,
  extractLegacyLocation,
  normalizeStoredBookingStatus,
  stringifyRegiondoId
} from './mappers.js';
import type {
  RegiondoPurchaseData,
  RegiondoSoldItem,
  RegiondoSupplierBooking,
  RegiondoWebhookPayload
} from './types.js';

export interface RegiondoWebhookEventRecord {
  event_id: string;
  booking_key: string;
  order_number: string | null;
  action_type: string | null;
  channel: string | null;
  provider_snapshot_at: Date | string | null;
  payload: unknown;
  headers: unknown;
  attempt_count: number;
}

type RegiondoWebhookEventStatus = 'pending' | 'processing' | 'retrying' | 'processed' | 'dead_letter';

export interface RegiondoSyncSummary {
  pending: number;
  processing: number;
  retrying: number;
  deadLetter: number;
  processedLast24h: number;
  oldestPendingCreatedAt: string | null;
  oldestPendingAgeSeconds: number | null;
  latestProcessedAt: string | null;
}

export interface ListRegiondoWebhookEventsFilters {
  status?: RegiondoWebhookEventStatus;
  bookingKey?: string;
  orderNumber?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface RegiondoWebhookEventAdminRecord {
  eventId: string;
  canonicalBookingId: string | null;
  bookingKey: string;
  orderNumber: string | null;
  actionType: string | null;
  channel: string | null;
  payloadKind: 'purchase_data_push' | 'legacy_booking_event' | 'unknown';
  status: RegiondoWebhookEventStatus;
  attemptCount: number;
  lastError: string | null;
  providerSnapshotAt: string | null;
  availableAt: string;
  lockedAt: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedRegiondoWebhookEvents {
  items: RegiondoWebhookEventAdminRecord[];
  nextCursor: string | null;
}

export interface RegiondoCanonicalBookingIdentifiers {
  bookingId: string;
  bookingKey: string | null;
  orderNumber: string | null;
}

export class RegiondoSyncValidationError extends Error {}

interface ExistingBookingSnapshotRow {
  booking_id: string;
  dt_from: Date | string;
  dt_to: Date | string;
  location_override: string | null;
  regiondo_snapshot_generated_at: Date | string | null;
}

interface RegiondoWebhookEventSummaryRow {
  pending_count: string | number;
  processing_count: string | number;
  retrying_count: string | number;
  dead_letter_count: string | number;
  processed_last_24h_count: string | number;
  oldest_pending_created_at: Date | string | null;
  oldest_pending_age_seconds: string | number | null;
  latest_processed_at: Date | string | null;
}

interface RegiondoWebhookEventAdminRow {
  event_id: string;
  booking_key: string;
  order_number: string | null;
  action_type: string | null;
  channel: string | null;
  status: RegiondoWebhookEventStatus;
  attempt_count: number;
  last_error: string | null;
  provider_snapshot_at: Date | string | null;
  available_at: Date | string;
  locked_at: Date | string | null;
  processed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  payload: unknown;
  booking_id: string | null;
}

interface RegiondoWebhookEventsCursor {
  createdAt: string;
  eventId: string;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value instanceof Date ? value : new Date(value);
  return Number.isNaN(normalized.getTime()) ? null : normalized.toISOString();
}

function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeIsoDateInput(value: string, fieldName: string): string {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new RegiondoSyncValidationError(`${fieldName} must be a valid ISO date.`);
  }

  return normalized.toISOString();
}

function resolveWebhookPayloadKind(payload: unknown): 'purchase_data_push' | 'legacy_booking_event' | 'unknown' {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'unknown';
  }

  if ('full_purchase_data' in payload) {
    return 'purchase_data_push';
  }

  if ('id' in payload) {
    return 'legacy_booking_event';
  }

  return 'unknown';
}

function encodeRegiondoWebhookEventsCursor(cursor: RegiondoWebhookEventsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeRegiondoWebhookEventsCursor(rawCursor: string): RegiondoWebhookEventsCursor {
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as Partial<RegiondoWebhookEventsCursor>;

    if (typeof decoded.createdAt !== 'string' || typeof decoded.eventId !== 'string') {
      throw new Error('Cursor shape mismatch.');
    }

    const normalized = new Date(decoded.createdAt);
    if (Number.isNaN(normalized.getTime())) {
      throw new Error('Cursor date mismatch.');
    }

    return {
      createdAt: normalized.toISOString(),
      eventId: decoded.eventId
    };
  } catch {
    throw new RegiondoSyncValidationError('cursor must be a valid Regiondo webhook events cursor.');
  }
}

function mapRegiondoWebhookEventRow(row: RegiondoWebhookEventAdminRow): RegiondoWebhookEventAdminRecord {
  return {
    eventId: row.event_id,
    canonicalBookingId: row.booking_id,
    bookingKey: row.booking_key,
    orderNumber: row.order_number,
    actionType: row.action_type,
    channel: row.channel,
    payloadKind: resolveWebhookPayloadKind(row.payload),
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    providerSnapshotAt: toIsoString(row.provider_snapshot_at),
    availableAt: toIsoString(row.available_at) ?? new Date(0).toISOString(),
    lockedAt: toIsoString(row.locked_at),
    processedAt: toIsoString(row.processed_at),
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
  };
}

function normalizeHeaderMap(headers: Record<string, string | string[] | undefined>) {
  const normalized: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    normalized[key] = Array.isArray(value) ? value : `${value}`;
  }

  return normalized;
}

function hashRawPayload(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

function normalizeClientNames(input: { firstName?: string | null; lastName?: string | null }) {
  return {
    firstName: input.firstName?.trim() || 'Unknown',
    lastName: input.lastName?.trim() || 'Unknown'
  };
}

function deriveContactDetails(input: {
  purchaseData: RegiondoPurchaseData;
  supplierBookings: RegiondoSupplierBooking[];
}): { firstName: string; lastName: string; email: string | null; phoneNumber: string | null } {
  const purchaseContact = input.purchaseData.contact_data;
  const fallbackBooking = input.supplierBookings[0];
  const bookingContact = fallbackBooking?.contact_data;
  const names = normalizeClientNames({
    firstName: purchaseContact?.firstname ?? bookingContact?.firstname ?? fallbackBooking?.first_name ?? null,
    lastName: purchaseContact?.lastname ?? bookingContact?.lastname ?? fallbackBooking?.last_name ?? null
  });

  return {
    ...names,
    email:
      purchaseContact?.email?.trim() ||
      bookingContact?.email?.trim() ||
      fallbackBooking?.email?.trim() ||
      null,
    phoneNumber:
      purchaseContact?.telephone?.trim() ||
      bookingContact?.telephone?.trim() ||
      fallbackBooking?.phone_number?.trim() ||
      null
  };
}

async function findOrCreateClient(
  client: PoolClient,
  input: {
    regiondoCustomerId: string | null;
    firstName: string;
    lastName: string;
    email: string | null;
    phoneNumber: string | null;
    raw: unknown;
  }
): Promise<string> {
  if (input.regiondoCustomerId) {
    const result = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_customer_id, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5, $6)
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
       VALUES ($1, $2, $3, $4, $5)
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
     VALUES ('Unknown', 'Unknown', $1, $2)
     ON CONFLICT (regiondo_customer_id)
     DO UPDATE SET regiondo_raw = EXCLUDED.regiondo_raw, updated_at = now()
     RETURNING client_id`,
    [SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID, JSON.stringify(input.raw)]
  );

  return result.rows[0].client_id;
}

async function findOrCreateLocation(
  client: PoolClient,
  input: { regiondoLocationId: string | null; title: string | null; raw: unknown }
): Promise<string> {
  if (input.regiondoLocationId) {
    const result = await client.query<{ location_id: string }>(
      `INSERT INTO locations (title, regiondo_location_id, regiondo_raw)
       VALUES ($1, $2, $3)
       ON CONFLICT (regiondo_location_id)
       DO UPDATE SET title = EXCLUDED.title,
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING location_id`,
      [input.title?.trim() || 'Imported Location', input.regiondoLocationId, JSON.stringify(input.raw)]
    );

    return result.rows[0].location_id;
  }

  const result = await client.query<{ location_id: string }>(
    `INSERT INTO locations (title, regiondo_location_id, regiondo_raw)
     VALUES ('Unknown Location', $1, $2)
     ON CONFLICT (regiondo_location_id)
     DO UPDATE SET regiondo_raw = EXCLUDED.regiondo_raw, updated_at = now()
     RETURNING location_id`,
    [SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID, JSON.stringify(input.raw)]
  );

  return result.rows[0].location_id;
}

async function findOrCreateNoLocationPlaceholder(client: PoolClient): Promise<string> {
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

async function ensureBookingProductStub(
  client: PoolClient,
  input: { regiondoProductId: string; title: string; baseAmount: number; raw: unknown }
): Promise<string> {
  const result = await client.query<{ product_id: string }>(
    `INSERT INTO products (title, base_amount, regiondo_product_id, regiondo_raw)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (regiondo_product_id)
     DO UPDATE SET title = EXCLUDED.title,
                   base_amount = CASE
                     WHEN products.base_amount = 0 AND EXCLUDED.base_amount > 0 THEN EXCLUDED.base_amount
                     ELSE products.base_amount
                   END,
                   regiondo_raw = COALESCE(products.regiondo_raw, EXCLUDED.regiondo_raw),
                   updated_at = now()
     RETURNING product_id`,
    [input.title, input.baseAmount, input.regiondoProductId, JSON.stringify(input.raw)]
  );

  return result.rows[0].product_id;
}

function selectPurchaseItemsForBooking(purchaseData: RegiondoPurchaseData, bookingKey: string): RegiondoSoldItem[] {
  return purchaseData.items.filter((item) => item.booking_key === bookingKey);
}

function sumBookingTotals(items: RegiondoSoldItem[]) {
  return items.reduce(
    (accumulator, item) => {
      const rowTotal = typeof item.row_total_incl_tax === 'number' && Number.isFinite(item.row_total_incl_tax) ? item.row_total_incl_tax : 0;
      const paid = item.payment_status?.toLowerCase() === 'paid' ? rowTotal : 0;

      return {
        totalAmount: accumulator.totalAmount + rowTotal,
        paidAmount: accumulator.paidAmount + paid,
        guestCount:
          accumulator.guestCount +
          (typeof item.ticket_qty === 'number' && Number.isFinite(item.ticket_qty) ? item.ticket_qty : 0)
      };
    },
    { totalAmount: 0, paidAmount: 0, guestCount: 0 }
  );
}

export async function enqueueRegiondoWebhookEvents(input: {
  payload: RegiondoWebhookPayload;
  bookingKeys: string[];
  orderNumber: string | null;
  actionType: string;
  channel: string;
  providerSnapshotAt: string | null;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<number> {
  if (!input.bookingKeys.length) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const headers = normalizeHeaderMap(input.headers);
    const payloadHash = hashRawPayload(input.rawBody);
    let insertedCount = 0;

    for (const bookingKey of new Set(input.bookingKeys)) {
      const result = await client.query<{ event_id: string }>(
        `INSERT INTO regiondo_webhook_events (
           booking_key,
           order_number,
           action_type,
           channel,
           dedupe_key,
           provider_snapshot_at,
           payload,
           headers
         )
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING event_id`,
        [
          bookingKey,
          input.orderNumber,
          input.actionType,
          input.channel,
          `${bookingKey}:${payloadHash}`,
          input.providerSnapshotAt,
          JSON.stringify(input.payload),
          JSON.stringify(headers)
        ]
      );

      insertedCount += result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return insertedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimRegiondoWebhookEvents(limit: number): Promise<RegiondoWebhookEventRecord[]> {
  const result = await pool.query<RegiondoWebhookEventRecord>(
    `WITH next_events AS (
       SELECT event_id
       FROM regiondo_webhook_events
       WHERE status IN ('pending', 'retrying')
         AND available_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE regiondo_webhook_events AS events
     SET status = 'processing',
         attempt_count = events.attempt_count + 1,
         locked_at = now(),
         last_error = null
     FROM next_events
     WHERE events.event_id = next_events.event_id
     RETURNING
       events.event_id,
       events.booking_key,
       events.order_number,
       events.action_type,
       events.channel,
       events.provider_snapshot_at,
       events.payload,
       events.headers,
       events.attempt_count`,
    [limit]
  );

  return result.rows;
}

export async function markRegiondoWebhookEventProcessed(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'processed',
         processed_at = now(),
         locked_at = null,
         last_error = null
     WHERE event_id = $1`,
    [eventId]
  );
}

export async function markRegiondoWebhookEventRetry(eventId: string, errorMessage: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'retrying',
         available_at = $2::timestamptz,
         locked_at = null,
         last_error = $3
     WHERE event_id = $1`,
    [eventId, nextAttemptAt.toISOString(), errorMessage]
  );
}

export async function markRegiondoWebhookEventDeadLetter(eventId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'dead_letter',
         processed_at = now(),
         locked_at = null,
         last_error = $2
     WHERE event_id = $1`,
    [eventId, errorMessage]
  );
}

export async function getRegiondoSyncSummary(): Promise<RegiondoSyncSummary> {
  const result = await pool.query<RegiondoWebhookEventSummaryRow>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
       COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
       COUNT(*) FILTER (WHERE status = 'retrying') AS retrying_count,
       COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_count,
       COUNT(*) FILTER (WHERE status = 'processed' AND processed_at >= now() - interval '24 hours') AS processed_last_24h_count,
       MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_created_at,
       EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'pending'))) AS oldest_pending_age_seconds,
       MAX(processed_at) FILTER (WHERE status = 'processed') AS latest_processed_at
     FROM regiondo_webhook_events`
  );

  const row = result.rows[0];

  return {
    pending: Number(row.pending_count),
    processing: Number(row.processing_count),
    retrying: Number(row.retrying_count),
    deadLetter: Number(row.dead_letter_count),
    processedLast24h: Number(row.processed_last_24h_count),
    oldestPendingCreatedAt: toIsoString(row.oldest_pending_created_at),
    oldestPendingAgeSeconds: toFiniteNumber(row.oldest_pending_age_seconds),
    latestProcessedAt: toIsoString(row.latest_processed_at)
  };
}

export async function listRegiondoWebhookEvents(
  filters: ListRegiondoWebhookEventsFilters = {}
): Promise<PaginatedRegiondoWebhookEvents> {
  const values: Array<number | string> = [];
  const where: string[] = [];
  const pageSize = filters.limit ?? 50;

  if (filters.status) {
    values.push(filters.status);
    where.push(`events.status = $${values.length}`);
  }

  if (filters.bookingKey?.trim()) {
    values.push(`%${filters.bookingKey.trim()}%`);
    where.push(`events.booking_key ILIKE $${values.length}`);
  }

  if (filters.orderNumber?.trim()) {
    values.push(`%${filters.orderNumber.trim()}%`);
    where.push(`COALESCE(events.order_number, '') ILIKE $${values.length}`);
  }

  if (filters.from) {
    values.push(normalizeIsoDateInput(filters.from, 'from'));
    where.push(`events.created_at >= $${values.length}::timestamptz`);
  }

  if (filters.to) {
    values.push(normalizeIsoDateInput(filters.to, 'to'));
    where.push(`events.created_at <= $${values.length}::timestamptz`);
  }

  if (filters.cursor) {
    const cursor = decodeRegiondoWebhookEventsCursor(filters.cursor);
    values.push(cursor.createdAt);
    const createdAtParam = `$${values.length}`;
    values.push(cursor.eventId);
    const eventIdParam = `$${values.length}`;
    where.push(`(events.created_at, events.event_id) < (${createdAtParam}::timestamptz, ${eventIdParam}::uuid)`);
  }

  values.push(pageSize + 1);
  const limitParam = `$${values.length}`;
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await pool.query<RegiondoWebhookEventAdminRow>(
    `SELECT
       events.event_id,
       events.booking_key,
       events.order_number,
       events.action_type,
       events.channel,
       events.status,
       events.attempt_count,
       events.last_error,
       events.provider_snapshot_at,
       events.available_at,
       events.locked_at,
       events.processed_at,
       events.created_at,
       events.updated_at,
       events.payload,
       bookings.booking_id
     FROM regiondo_webhook_events events
     LEFT JOIN bookings ON bookings.regiondo_booking_id = events.booking_key
     ${whereClause}
     ORDER BY events.created_at DESC, events.event_id DESC
     LIMIT ${limitParam}`,
    values
  );

  const pageRows = result.rows.slice(0, pageSize);
  const nextRow = result.rows.length > pageSize ? pageRows[pageRows.length - 1] : null;

  return {
    items: pageRows.map(mapRegiondoWebhookEventRow),
    nextCursor: nextRow
      ? encodeRegiondoWebhookEventsCursor({
          createdAt: toIsoString(nextRow.created_at) ?? new Date(0).toISOString(),
          eventId: nextRow.event_id
        })
      : null
  };
}

export async function getRegiondoWebhookEvent(eventId: string): Promise<RegiondoWebhookEventAdminRecord | null> {
  const result = await pool.query<RegiondoWebhookEventAdminRow>(
    `SELECT
       events.event_id,
       events.booking_key,
       events.order_number,
       events.action_type,
       events.channel,
       events.status,
       events.attempt_count,
       events.last_error,
       events.provider_snapshot_at,
       events.available_at,
       events.locked_at,
       events.processed_at,
       events.created_at,
       events.updated_at,
       events.payload,
       bookings.booking_id
     FROM regiondo_webhook_events events
     LEFT JOIN bookings ON bookings.regiondo_booking_id = events.booking_key
     WHERE events.event_id = $1
     LIMIT 1`,
    [eventId]
  );

  return result.rowCount ? mapRegiondoWebhookEventRow(result.rows[0]) : null;
}

export async function retryRegiondoWebhookEvent(eventId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'retrying',
         available_at = now(),
         processed_at = null,
         locked_at = null,
         last_error = null
     WHERE event_id = $1
       AND status IN ('retrying', 'dead_letter')`,
    [eventId]
  );

  return Boolean(result.rowCount);
}

export async function getCanonicalBookingIdentifiers(
  bookingId: string
): Promise<RegiondoCanonicalBookingIdentifiers | null> {
  const result = await pool.query<{
    booking_id: string;
    regiondo_booking_id: string | null;
    regiondo_order_number: string | null;
  }>(
    `SELECT booking_id, regiondo_booking_id, regiondo_order_number
     FROM bookings
     WHERE booking_id = $1
     LIMIT 1`,
    [bookingId]
  );

  if (!result.rowCount) {
    return null;
  }

  return {
    bookingId: result.rows[0].booking_id,
    bookingKey: result.rows[0].regiondo_booking_id,
    orderNumber: result.rows[0].regiondo_order_number
  };
}

export async function importCanonicalRegiondoBooking(input: {
  bookingKey: string;
  purchaseData: RegiondoPurchaseData;
  supplierBookings: RegiondoSupplierBooking[];
  webhookPayload?: RegiondoWebhookPayload | null;
}): Promise<void> {
  const matchingSupplierBookings = input.supplierBookings.filter((booking) => booking.booking_key === input.bookingKey);
  if (!matchingSupplierBookings.length) {
    throw new Error(`Regiondo supplier snapshot did not return booking key ${input.bookingKey}.`);
  }

  const matchingPurchaseItems = selectPurchaseItemsForBooking(input.purchaseData, input.bookingKey);
  if (!matchingPurchaseItems.length) {
    throw new Error(`Regiondo purchase snapshot did not contain items for booking key ${input.bookingKey}.`);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query<ExistingBookingSnapshotRow>(
      `SELECT
         b.booking_id,
         b.dt_from,
         b.dt_to,
         admin.location_override,
         b.regiondo_snapshot_generated_at
       FROM bookings b
       LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
       WHERE b.regiondo_booking_id = $1
       LIMIT 1
       FOR UPDATE OF b`,
      [input.bookingKey]
    );

    const existingRow = existing.rowCount ? existing.rows[0] : null;
    const snapshotAt = new Date(input.purchaseData.info_generated_at);
    if (Number.isNaN(snapshotAt.getTime())) {
      throw new Error('Regiondo purchase snapshot did not include a valid info_generated_at timestamp.');
    }

    const existingSnapshotAt = toIsoString(existingRow?.regiondo_snapshot_generated_at);
    if (existingSnapshotAt && new Date(existingSnapshotAt).getTime() >= snapshotAt.getTime()) {
      await client.query('ROLLBACK');
      return;
    }

    const contactDetails = deriveContactDetails({
      purchaseData: input.purchaseData,
      supplierBookings: matchingSupplierBookings
    });
    const legacyCustomerId = input.webhookPayload ? extractLegacyCustomerId(input.webhookPayload) : null;
    const legacyLocation = input.webhookPayload
      ? extractLegacyLocation(input.webhookPayload)
      : { regiondoLocationId: null, title: null };

    const clientId = await findOrCreateClient(client, {
      regiondoCustomerId: legacyCustomerId,
      firstName: contactDetails.firstName,
      lastName: contactDetails.lastName,
      email: contactDetails.email,
      phoneNumber: contactDetails.phoneNumber,
      raw: {
        source: 'regiondo',
        contactData: input.purchaseData.contact_data ?? null,
        supplierBookings: matchingSupplierBookings
      }
    });

    const providerLocationId = await findOrCreateLocation(client, {
      regiondoLocationId: legacyLocation.regiondoLocationId,
      title: legacyLocation.title,
      raw: legacyLocation.regiondoLocationId
        ? { source: 'regiondo', webhookLocation: legacyLocation, bookingKey: input.bookingKey }
        : { source: 'regiondo_placeholder', bookingKey: input.bookingKey }
    });
    const locationId =
      existingRow?.location_override === 'none' ? await findOrCreateNoLocationPlaceholder(client) : providerLocationId;

    const currentDurationMs =
      existingRow && toIsoString(existingRow.dt_from) && toIsoString(existingRow.dt_to)
        ? new Date(toIsoString(existingRow.dt_to) as string).getTime() - new Date(toIsoString(existingRow.dt_from) as string).getTime()
        : null;
    const { dtFrom, dtTo } = calculateBookingRange({
      supplierBookings: matchingSupplierBookings,
      purchaseTimestamp: input.purchaseData.purchased_at,
      existingDurationMs: currentDurationMs
    });
    const totals = sumBookingTotals(matchingPurchaseItems);
    const bookingStatus = aggregateBookingStatus(matchingSupplierBookings);
    const raw = {
      provider: {
        purchaseData: input.purchaseData,
        supplierBookings: matchingSupplierBookings
      },
      webhook: input.webhookPayload
    };

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
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'regiondo', $9, $10, $11::timestamptz, $12)
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
        normalizeStoredBookingStatus(bookingStatus),
        Math.max(1, totals.guestCount || matchingSupplierBookings.reduce((sum, booking) => sum + (booking.qty ?? 0), 0)),
        totals.totalAmount,
        totals.paidAmount,
        dtFrom,
        dtTo,
        input.bookingKey,
        stringifyRegiondoId(input.purchaseData.order_number),
        snapshotAt.toISOString(),
        JSON.stringify(raw)
      ]
    );

    const bookingId = bookingResult.rows[0].booking_id;
    await client.query('DELETE FROM booking_products WHERE booking_id = $1', [bookingId]);

    for (const item of matchingPurchaseItems) {
      const productId = stringifyRegiondoId(item.product_id);
      if (!productId) {
        continue;
      }

      const storedProductId = await ensureBookingProductStub(client, {
        regiondoProductId: productId,
        title: item.ticket_name?.trim() || item.product_name?.trim() || 'Imported Product',
        baseAmount:
          typeof item.price_per_one_incl_tax === 'number' && Number.isFinite(item.price_per_one_incl_tax)
            ? item.price_per_one_incl_tax
            : 0,
        raw: item
      });

      await client.query(
        `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (booking_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       unit_price = EXCLUDED.unit_price`,
        [
          bookingId,
          storedProductId,
          Math.max(1, item.ticket_qty ?? 1),
          typeof item.price_per_one_incl_tax === 'number' && Number.isFinite(item.price_per_one_incl_tax)
            ? item.price_per_one_incl_tax
            : 0
        ]
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
