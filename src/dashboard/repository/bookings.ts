import { pool } from '../../db/client.js';
import type {
  DashboardBooking,
  DashboardBookingActivityEntry,
  DashboardBookingDetail,
  DashboardBookingProduct,
  DashboardBookingSort,
  DashboardBookingSyncInfo,
  DashboardPaginatedBookingsResponse,
  DashboardRegiondoWebhookEventStatus,
  DashboardSortDirection,
  ListDashboardBookingsFilters,
  UpdateDashboardBookingInput
} from '../types.js';
import {
  type BookingRow,
  type ExistingBookingRow,
  type Queryable,
  DashboardNotFoundError,
  DashboardValidationError,
  mapBookingRow,
  mapDashboardExternalStatusToDb,
  requireIsoString,
  toIsoString,
  toIsoStringOrThrow
} from './core.js';

const DEFAULT_BOOKINGS_PAGE_SIZE = 50;

interface BookingProductRow {
  product_id: string;
  title: string;
  quantity: number;
  unit_price: string | number;
}

interface BookingSyncRow {
  booking_id: string;
  regiondo_booking_id: string | null;
  regiondo_order_number: string | null;
  regiondo_snapshot_generated_at: Date | string | null;
  latest_event_id: string | null;
  latest_event_status: DashboardRegiondoWebhookEventStatus | null;
  latest_event_action_type: string | null;
  latest_event_channel: string | null;
  latest_event_created_at: Date | string | null;
  latest_event_available_at: Date | string | null;
  latest_event_processed_at: Date | string | null;
  latest_event_provider_snapshot_at: Date | string | null;
  latest_event_attempt_count: number | null;
  latest_event_last_error: string | null;
}

interface BookingAuditActivityRow {
  id: string;
  created_at: Date | string;
  action: string;
  details: unknown;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
}

interface BookingSyncActivityRow {
  event_id: string;
  status: DashboardRegiondoWebhookEventStatus;
  action_type: string | null;
  channel: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: Date | string;
  processed_at: Date | string | null;
  available_at: Date | string;
  provider_snapshot_at: Date | string | null;
  order_number: string | null;
}

interface BookingListCursor {
  sort: DashboardBookingSort;
  direction: DashboardSortDirection;
  sortValue: string;
  bookingId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildBookingBaseQuery() {
  return `SELECT
       b.booking_id AS id,
       b.status,
       b.guest_count,
       b.total_amount,
       b.paid_amount,
       b.dt_from,
       b.updated_at,
       b.regiondo_raw AS booking_raw,
       COALESCE(
         NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,firstname}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,firstname}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,first_name}', ''),
         c.first_name
       ) AS first_name,
       COALESCE(
         NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,lastname}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,lastname}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,last_name}', ''),
         c.last_name
       ) AS last_name,
       COALESCE(
         NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,email}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,email}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,email}', ''),
         c.email::text
       ) AS email,
       product_lookup.primary_product_title AS product_title,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       c.regiondo_customer_id AS client_regiondo_customer_id,
       location.location_id,
       location.title AS location_title,
       location.regiondo_location_id AS location_regiondo_location_id,
       admin.ops_status,
       admin.ops_notes
     FROM bookings b
     INNER JOIN clients c ON c.client_id = b.client_id
     LEFT JOIN locations location ON location.location_id = b.location_id
     LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
     LEFT JOIN LATERAL (
       SELECT
         MIN(p.title) AS primary_product_title,
         string_agg(DISTINCT p.title, ' | ' ORDER BY p.title) AS product_titles
       FROM booking_products bp
       INNER JOIN products p ON p.product_id = bp.product_id
       WHERE bp.booking_id = b.booking_id
     ) AS product_lookup ON true`;
}

function resolveBookingFilters(filters: ListDashboardBookingsFilters = {}) {
  let externalStatus = filters.externalStatus;
  let opsStatus = filters.opsStatus;

  if (filters.status === "Escalated" && !opsStatus) {
    opsStatus = "Escalated";
  } else if (filters.status && filters.status !== "Escalated" && !externalStatus) {
    externalStatus = filters.status;
  }

  return { ...filters, externalStatus, opsStatus };
}

function encodeBookingCursor(cursor: BookingListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeBookingCursor(
  rawCursor: string,
  sort: DashboardBookingSort,
  direction: DashboardSortDirection
): BookingListCursor {
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as Partial<BookingListCursor>;

    if (
      decoded.sort !== sort ||
      decoded.direction !== direction ||
      typeof decoded.sortValue !== "string" ||
      typeof decoded.bookingId !== "string"
    ) {
      throw new Error("Cursor shape mismatch.");
    }

    toIsoStringOrThrow(decoded.sortValue, "cursor.sortValue");
    return decoded as BookingListCursor;
  } catch {
    throw new DashboardValidationError("cursor must be a valid booking pagination cursor.");
  }
}

function getBookingSortConfig(filters: ListDashboardBookingsFilters) {
  const sort = filters.sort ?? "bookingDate";
  const direction = filters.direction ?? "asc";

  return {
    sort,
    direction,
    column: sort === "lastUpdated" ? "b.updated_at" : "b.dt_from"
  };
}

function buildListBookingsQuery(filters: ListDashboardBookingsFilters = {}) {
  const resolved = resolveBookingFilters(filters);
  const values: Array<number | string> = [];
  const where: string[] = [];
  const { sort, direction, column } = getBookingSortConfig(resolved);
  const pageSize = resolved.limit ?? DEFAULT_BOOKINGS_PAGE_SIZE;

  if (resolved.externalStatus) {
    values.push(mapDashboardExternalStatusToDb(resolved.externalStatus));
    where.push(`b.status = $${values.length}`);
  }

  if (resolved.opsStatus) {
    values.push(resolved.opsStatus === "Escalated" ? "escalated" : "normal");
    where.push(`COALESCE(admin.ops_status, 'normal') = $${values.length}`);
  }

  if (resolved.locationId) {
    values.push(resolved.locationId);
    where.push(`b.location_id = $${values.length}::uuid`);
  }

  if (resolved.from) {
    values.push(toIsoStringOrThrow(resolved.from, "from"));
    where.push(`b.dt_from >= $${values.length}::timestamptz`);
  }

  if (resolved.to) {
    values.push(toIsoStringOrThrow(resolved.to, "to"));
    where.push(`b.dt_from <= $${values.length}::timestamptz`);
  }

  if (resolved.updatedSince) {
    values.push(toIsoStringOrThrow(resolved.updatedSince, "updatedSince"));
    where.push(`b.updated_at >= $${values.length}::timestamptz`);
  }

  if (resolved.search?.trim()) {
    values.push(`%${resolved.search.trim()}%`);
    const searchParam = `$${values.length}`;
    where.push(`(
      COALESCE(
        NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,firstname}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,firstname}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,first_name}', ''),
        c.first_name,
        ''
      ) ILIKE ${searchParam}
      OR COALESCE(
        NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,lastname}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,lastname}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,last_name}', ''),
        c.last_name,
        ''
      ) ILIKE ${searchParam}
      OR COALESCE(
        NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,email}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,email}', ''),
        NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,email}', ''),
        c.email::text,
        ''
      ) ILIKE ${searchParam}
      OR COALESCE(product_lookup.product_titles, '') ILIKE ${searchParam}
      OR COALESCE(location.title, '') ILIKE ${searchParam}
      OR COALESCE(b.regiondo_booking_id, '') ILIKE ${searchParam}
      OR COALESCE(b.regiondo_order_number, '') ILIKE ${searchParam}
      OR COALESCE(admin.ops_notes, '') ILIKE ${searchParam}
    )`);
  }

  if (resolved.cursor) {
    const cursor = decodeBookingCursor(resolved.cursor, sort, direction);
    values.push(cursor.sortValue);
    const sortValueParam = `$${values.length}`;
    values.push(cursor.bookingId);
    const bookingIdParam = `$${values.length}`;
    where.push(
      `(${column}, b.booking_id) ${direction === "asc" ? ">" : "<"} (${sortValueParam}::timestamptz, ${bookingIdParam}::uuid)`
    );
  }

  values.push(pageSize + 1);
  const limitParam = `$${values.length}`;
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  return {
    query: `${buildBookingBaseQuery()}${whereClause}
      ORDER BY ${column} ${direction.toUpperCase()}, b.booking_id ${direction.toUpperCase()}
      LIMIT ${limitParam}`,
    values,
    sort,
    pageSize
  };
}

async function queryBookingRow(executor: Queryable, bookingId: string): Promise<BookingRow | null> {
  const result = await executor.query<BookingRow>(
    `${buildBookingBaseQuery()}
     WHERE b.booking_id = $1
     LIMIT 1`,
    [bookingId]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function queryBookingProducts(executor: Queryable, bookingId: string): Promise<DashboardBookingProduct[]> {
  const result = await executor.query<BookingProductRow>(
    `SELECT
       p.product_id,
       p.title,
       bp.quantity,
       bp.unit_price
     FROM booking_products bp
     INNER JOIN products p ON p.product_id = bp.product_id
     WHERE bp.booking_id = $1
     ORDER BY p.title ASC`,
    [bookingId]
  );

  return result.rows.map((row) => ({
    productId: row.product_id,
    title: row.title,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price)
  }));
}

async function queryBookingSyncRow(executor: Queryable, bookingId: string): Promise<BookingSyncRow | null> {
  const result = await executor.query<BookingSyncRow>(
    `SELECT
       b.booking_id,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       b.regiondo_snapshot_generated_at,
       latest.event_id AS latest_event_id,
       latest.status AS latest_event_status,
       latest.action_type AS latest_event_action_type,
       latest.channel AS latest_event_channel,
       latest.created_at AS latest_event_created_at,
       latest.available_at AS latest_event_available_at,
       latest.processed_at AS latest_event_processed_at,
       latest.provider_snapshot_at AS latest_event_provider_snapshot_at,
       latest.attempt_count AS latest_event_attempt_count,
       latest.last_error AS latest_event_last_error
     FROM bookings b
     LEFT JOIN LATERAL (
       SELECT
         event_id,
         status,
         action_type,
         channel,
         created_at,
         available_at,
         processed_at,
         provider_snapshot_at,
         attempt_count,
         last_error
       FROM regiondo_webhook_events
       WHERE booking_key = b.regiondo_booking_id
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1
     ) AS latest ON true
     WHERE b.booking_id = $1
     LIMIT 1`,
    [bookingId]
  );

  return result.rowCount ? result.rows[0] : null;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value instanceof Date ? value : new Date(value);
  return Number.isNaN(normalized.getTime()) ? null : normalized.getTime();
}

function mapBookingSyncRow(row: BookingSyncRow): DashboardBookingSyncInfo {
  const lastCanonicalSnapshotAt = toIsoString(row.regiondo_snapshot_generated_at);
  const latestEventCreatedAt = toIsoString(row.latest_event_created_at);
  const latestEventAvailableAt = toIsoString(row.latest_event_available_at);
  const latestEventProcessedAt = toIsoString(row.latest_event_processed_at);
  const latestEventProviderSnapshotAt = toIsoString(row.latest_event_provider_snapshot_at);
  const latestSignalAt = latestEventProviderSnapshotAt ?? latestEventCreatedAt;
  const isQueued =
    row.latest_event_status === "pending" ||
    row.latest_event_status === "processing" ||
    row.latest_event_status === "retrying";
  const isStale =
    row.latest_event_status === "dead_letter" ||
    isQueued ||
    (latestSignalAt !== null &&
      (lastCanonicalSnapshotAt === null || (toTimestamp(latestSignalAt) ?? 0) > (toTimestamp(lastCanonicalSnapshotAt) ?? 0)));

  return {
    lastCanonicalSnapshotAt,
    latestEventId: row.latest_event_id,
    latestEventStatus: row.latest_event_status,
    latestEventActionType: row.latest_event_action_type,
    latestEventChannel: row.latest_event_channel,
    latestEventCreatedAt,
    latestEventProviderSnapshotAt,
    latestEventAvailableAt,
    latestEventProcessedAt,
    latestEventAttemptCount: row.latest_event_attempt_count ?? 0,
    lastSyncError: row.latest_event_last_error,
    isQueued,
    isStale
  };
}

function mapBookingAuditActivityRow(row: BookingAuditActivityRow): DashboardBookingActivityEntry {
  const details = isRecord(row.details) ? row.details : {};
  const changedFields = Array.isArray(details.changedFields)
    ? details.changedFields.filter((value): value is string => typeof value === "string")
    : [];

  if (row.action === "dashboard.booking.reconciled") {
    return {
      id: row.id,
      type: "reconcile_request",
      title: "Manual booking reconciliation requested",
      description: "A Regiondo refresh/import was triggered for this booking.",
      occurredAt: requireIsoString(row.created_at, 'admin_audit_log.created_at'),
      actor: {
        id: row.actor_user_id,
        name: row.actor_name ?? "System",
        role: row.actor_role,
        source: row.actor_user_id ? "user" : "system"
      },
      metadata: {
        regiondoBookingId: typeof details.regiondoBookingId === "string" ? details.regiondoBookingId : null,
        regiondoOrderNumber: typeof details.regiondoOrderNumber === "string" ? details.regiondoOrderNumber : null
      }
    };
  }

  const descriptionParts: string[] = [];
  if (changedFields.includes("opsStatus") && typeof details.opsStatus === "string") {
    descriptionParts.push(`Ops status is now ${details.opsStatus}.`);
  }

  if (changedFields.includes("opsNotes")) {
    descriptionParts.push(
      typeof details.opsNotes === "string" && details.opsNotes.trim() ? "Ops notes were updated." : "Ops notes were cleared."
    );
  }

  return {
    id: row.id,
    type: "ops_update",
    title:
      changedFields.includes("opsStatus") && details.opsStatus === "Escalated"
        ? "Booking escalated"
        : changedFields.includes("opsStatus")
          ? "Booking ops status updated"
          : changedFields.includes("opsNotes")
            ? "Booking notes updated"
            : "Booking updated",
    description: descriptionParts.join(" ") || "Booking operations metadata was updated.",
    occurredAt: requireIsoString(row.created_at, 'admin_audit_log.created_at'),
    actor: {
      id: row.actor_user_id,
      name: row.actor_name ?? "System",
      role: row.actor_role,
      source: row.actor_user_id ? "user" : "system"
    },
    metadata: {
      opsStatus: typeof details.opsStatus === "string" ? details.opsStatus : null,
      changedFieldCount: changedFields.length
    },
    status: typeof details.opsStatus === "string" ? details.opsStatus : null
  };
}

function mapBookingSyncActivityRow(row: BookingSyncActivityRow): DashboardBookingActivityEntry {
  const statusToTitle: Record<DashboardRegiondoWebhookEventStatus, string> = {
    pending: "Regiondo webhook queued",
    processing: "Regiondo webhook processing",
    retrying: "Regiondo webhook scheduled for retry",
    processed: "Regiondo webhook processed",
    dead_letter: "Regiondo webhook failed"
  };

  const descriptionParts = [
    row.action_type ? `Action: ${row.action_type}.` : null,
    row.channel ? `Channel: ${row.channel}.` : null,
    row.order_number ? `Order number: ${row.order_number}.` : null,
    row.last_error ? `Last error: ${row.last_error}` : null
  ].filter((value): value is string => Boolean(value));

  return {
    id: row.event_id,
    type: "sync_event",
    title: statusToTitle[row.status],
    description: descriptionParts.join(" ") || "Regiondo delivered a booking event.",
    occurredAt: requireIsoString(row.processed_at ?? row.created_at, 'regiondo_webhook_events.occurred_at'),
    actor: {
      id: null,
      name: "Regiondo",
      role: "Provider",
      source: "external"
    },
    metadata: {
      attemptCount: row.attempt_count,
      providerSnapshotAt: toIsoString(row.provider_snapshot_at),
      availableAt: toIsoString(row.available_at),
      orderNumber: row.order_number
    },
    status: row.status
  };
}

export async function getBooking(bookingId: string): Promise<DashboardBookingDetail> {
  const row = await queryBookingRow(pool, bookingId);
  if (!row) {
    throw new DashboardNotFoundError("Booking not found.");
  }

  const [products, sync] = await Promise.all([queryBookingProducts(pool, bookingId), getBookingSync(bookingId)]);

  return {
    ...mapBookingRow(row),
    products,
    sync
  };
}

export async function getBookingSync(bookingId: string): Promise<DashboardBookingSyncInfo> {
  const row = await queryBookingSyncRow(pool, bookingId);
  if (!row) {
    throw new DashboardNotFoundError("Booking not found.");
  }

  return mapBookingSyncRow(row);
}

export async function listBookings(
  filters: ListDashboardBookingsFilters = {}
): Promise<DashboardPaginatedBookingsResponse> {
  const { query, values, pageSize, sort } = buildListBookingsQuery(filters);
  const result = await pool.query<BookingRow>(query, values);
  const pageRows = result.rows.slice(0, pageSize);
  const nextRow = result.rows.length > pageSize ? pageRows[pageRows.length - 1] : null;

  return {
    items: pageRows.map(mapBookingRow),
    nextCursor: nextRow
      ? encodeBookingCursor({
          sort,
          direction: filters.direction ?? "asc",
          sortValue:
            sort === "lastUpdated"
              ? requireIsoString(nextRow.updated_at, 'bookings.updated_at')
              : requireIsoString(nextRow.dt_from, 'bookings.dt_from'),
          bookingId: nextRow.id
        })
      : null
  };
}

export async function listBookingActivity(bookingId: string): Promise<DashboardBookingActivityEntry[]> {
  const syncRow = await queryBookingSyncRow(pool, bookingId);
  if (!syncRow) {
    throw new DashboardNotFoundError("Booking not found.");
  }

  const [auditRows, syncRows] = await Promise.all([
    pool.query<BookingAuditActivityRow>(
      `SELECT
         log.id,
         log.created_at,
         log.action,
         log.details,
         log.actor_user_id,
         users.display_name AS actor_name,
         users.role AS actor_role
       FROM admin_audit_log log
       LEFT JOIN users ON users.id = log.actor_user_id
       WHERE log.entity_type = 'booking'
         AND log.entity_id = $1
         AND log.action IN ('dashboard.booking.updated', 'dashboard.booking.reconciled')
       ORDER BY log.created_at DESC, log.id DESC
       LIMIT 200`,
      [bookingId]
    ),
    syncRow.regiondo_booking_id
      ? pool.query<BookingSyncActivityRow>(
          `SELECT
             event_id,
             status,
             action_type,
             channel,
             last_error,
             attempt_count,
             created_at,
             processed_at,
             available_at,
             provider_snapshot_at,
             order_number
           FROM regiondo_webhook_events
           WHERE booking_key = $1
           ORDER BY created_at DESC, event_id DESC
           LIMIT 200`,
          [syncRow.regiondo_booking_id]
        )
      : Promise.resolve({ rows: [] as BookingSyncActivityRow[] })
  ]);

  return [...auditRows.rows.map(mapBookingAuditActivityRow), ...syncRows.rows.map(mapBookingSyncActivityRow)].sort(
    (left, right) => {
      const timeDiff = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
      return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
    }
  );
}

export async function updateBooking(bookingId: string, input: UpdateDashboardBookingInput): Promise<DashboardBookingDetail> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await client.query<ExistingBookingRow>(
      `SELECT
         b.booking_id,
         b.dt_from,
         b.dt_to,
         admin.ops_status,
         admin.ops_notes
       FROM bookings b
       LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
       WHERE b.booking_id = $1
       LIMIT 1
       FOR UPDATE`,
      [bookingId]
    );

    if (!existing.rowCount) {
      throw new DashboardNotFoundError("Booking not found.");
    }

    const current = existing.rows[0];
    const nextOpsStatus =
      input.opsStatus === "Escalated"
        ? "escalated"
        : input.opsStatus === "Normal"
          ? "normal"
          : current.ops_status ?? "normal";
    const nextOpsNotes = typeof input.opsNotes === "string" ? input.opsNotes.trim() : current.ops_notes ?? "";

    await client.query(
      `INSERT INTO booking_admin_metadata (booking_id, ops_status, ops_notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (booking_id)
       DO UPDATE SET ops_status = EXCLUDED.ops_status,
                     ops_notes = EXCLUDED.ops_notes,
                     updated_at = now()`,
      [bookingId, nextOpsStatus, nextOpsNotes]
    );

    await client.query("COMMIT");
    return await getBooking(bookingId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
