import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import { normalizeRegiondoBookingImport } from '../../modules/bookings/booking-normalizer.js';
import { upsertNormalizedRegiondoBooking } from '../../modules/bookings/booking.repository.js';
import {
  regiondoClient,
  type RegiondoCheckoutCartItem,
  type RegiondoCheckoutContactData,
  type RegiondoUpdateBookingInput
} from '../../modules/regiondo/regiondo.client.js';
import { formatRegiondoDateTime } from '../../modules/regiondo/regiondo-datetime.js';
import { rebuildConsumptionsForBooking } from '../../modules/resources/consumption.service.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';
import type {
  DashboardBooking,
  DashboardBookingActivityEntry,
  DashboardBookingDetail,
  DashboardBookingDrawerData,
  DashboardBookingProduct,
  DashboardTask,
  DashboardTaskActivityEntry,
  DashboardTaskMutationActor,
  DashboardBookingRegiondoSelection,
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
  type Queryable,
  type TaskRow,
  DashboardNotFoundError,
  DashboardValidationError,
  mapBookingRow,
  mapTaskRow,
  mapDashboardExternalStatusToDb,
  requireIsoString,
  toIsoString,
  toIsoStringOrThrow
} from './core.js';
import { appendTaskBookingLinks } from './tasks.js';

const DEFAULT_BOOKINGS_PAGE_SIZE = 50;
const SYSTEM_LOCATION_PROVIDER_IDS = new Set([
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
]);

interface BookingProductRow {
  product_id: string;
  regiondo_product_id: string | null;
  title: string;
  quantity: number;
  unit_price: string | number;
}

interface BookingForUpdateRow {
  booking_id: string;
  client_id: string;
  location_id: string | null;
  status: string;
  guest_count: number;
  total_amount: string | number;
  paid_amount: string | number;
  dt_from: Date | string;
  dt_to: Date | string;
  source: string | null;
  regiondo_booking_id: string | null;
  regiondo_order_number: string | null;
  regiondo_raw: unknown;
  updated_at: Date | string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  ops_status: string | null;
  ops_notes: string | null;
  last_provider_edit_error: string | null;
  location_override: string | null;
}

interface BookingLocationUpdateRow {
  location_id: string;
  title: string;
  regiondo_location_id: string | null;
}

type BookingLocationOverride = 'none' | null;

interface BookingProductUpdateRow {
  product_id: string;
  regiondo_product_id: string | null;
  title: string;
  base_amount: string | number;
}

interface ResolvedBookingProductUpdate {
  productId: string;
  regiondoProductId: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
}

interface ResolvedBookingUpdate {
  changedFields: string[];
  clearProviderEditError: boolean;
  contact: {
    email: string | null;
    firstName: string;
    lastName: string;
    phoneNumber: string | null;
  };
  dtFrom: string;
  dtTo: string;
  guestCount: number;
  locationId: string;
  locationOverride: BookingLocationOverride;
  opsNotes: string;
  opsStatus: 'normal' | 'escalated';
  payment: {
    amountPaid: number;
    amountToPay: number;
    paymentMethod: string | null;
  };
  products: ResolvedBookingProductUpdate[];
  regiondoLocationId: string | null;
  providerInput: RegiondoUpdateBookingInput | null;
  raw: unknown;
  rebuildConsumptions: boolean;
}

interface BookingSyncRow {
  booking_id: string;
  regiondo_booking_id: string | null;
  regiondo_order_number: string | null;
  regiondo_snapshot_generated_at: Date | string | null;
  last_provider_edit_error: string | null;
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

interface TaskBookingLocationRow {
  location_id: string;
  title: string;
  regiondo_location_id: string | null;
}

interface TaskBookingProductRow {
  product_id: string;
  title: string;
  base_amount: string | number;
  regiondo_product_id: string | null;
}

interface TaskBookingVariantRow {
  title: string | null;
  price: string | number | null;
}

interface TaskBookingOptionRow {
  title: string | null;
  values_json: unknown;
}

interface TaskBookingResolvedSelection {
  productId: string;
  productTitle: string;
  quantity: number;
  regiondoProductId: string | null;
  unitPrice: number;
  valuePath: string[];
  variationLabel: string | null;
  optionValueLabel: string | null;
}

interface TaskRegiondoBookingPayload {
  attendeeData: unknown[];
  buyerData: unknown[];
  comment: string | null;
  contactData: RegiondoCheckoutContactData;
  items: RegiondoCheckoutCartItem[];
  sendTicketsToCustomer: boolean;
  storeLocale: string | null;
  subId: string;
  syncTicketsProcessing: boolean;
}

const TASK_SELECT_QUERY = `SELECT
   t.id,
   t.title,
   t.description,
   t.created_at,
   t.updated_at,
   t.connected_booking_key,
   t.update_log,
   t.raw_json,
   t.event_date_time,
   t.reminder_date,
   t.reserved_capacity_date,
   c.id AS column_id,
   c.title AS column_title,
   c.position AS column_position,
   c.booking_related,
   u.id AS assignee_user_id,
   u.display_name AS owner_name,
   u.role AS owner_role
  FROM tasks t
  LEFT JOIN task_kanban_columns c ON c.id = t.column_key
  LEFT JOIN users u ON u.id = t.assignee_user_id`;

const TASK_BOOKING_ALLOWED_COLUMN_POSITIONS = new Set([3, 4, 5]);

interface BookingListCursor {
  sort: DashboardBookingSort;
  direction: DashboardSortDirection;
  sortValue: string;
  bookingId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function stringifyIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value}`;
  }

  return normalizeText(value);
}

function getProviderRecord(rawValue: unknown): Record<string, unknown> | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  const provider = rawValue.provider;
  if (isRecord(provider)) {
    return provider;
  }

  return rawValue;
}

function getPurchaseDataRecord(rawValue: unknown): Record<string, unknown> | null {
  const provider = getProviderRecord(rawValue);
  if (!provider) {
    return null;
  }

  const purchaseData = provider.purchaseData;
  return isRecord(purchaseData) ? purchaseData : null;
}

function getManualRecord(rawValue: unknown): Record<string, unknown> | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  const manual = rawValue.manual;
  return isRecord(manual) ? manual : null;
}

function canCreateBookingFromTaskColumnPosition(value: number): boolean {
  return TASK_BOOKING_ALLOWED_COLUMN_POSITIONS.has(value);
}

function readTaskRawText(task: DashboardTask, key: string): string | null {
  const value = task.rawJson[key];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  return null;
}

function readTaskRawSelection(task: DashboardTask, key: string): string[] {
  const value = task.rawJson[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

function readTaskSelectionPaths(task: DashboardTask): string[][] {
  return ['blocker_1_selection', 'blocker_2_selection']
    .map((key) => readTaskRawSelection(task, key))
    .filter((valuePath) => valuePath.length > 0);
}

function parseTaskBookingAmount(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(',', '.').trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTaskAttendees(task: DashboardTask): number {
  const bookingData = readTaskBookingData(task);
  const bookingDataAttendees = readRecordPositiveInteger(bookingData, 'attendees');
  if (bookingDataAttendees !== null) {
    return bookingDataAttendees;
  }

  const value = task.rawJson.attendees;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }

  return 1;
}

function readTaskRawRecord(task: DashboardTask, key: string): Record<string, unknown> | null {
  const value = task.rawJson[key];
  return isRecord(value) ? value : null;
}

function readTaskRawArray(task: DashboardTask, key: string): unknown[] {
  const value = task.rawJson[key];
  return Array.isArray(value) ? value : [];
}

function readTaskBookingData(task: DashboardTask): Record<string, unknown> | null {
  return readTaskRawRecord(task, 'booking_data') ?? readTaskRawRecord(task, 'bookingData');
}

function readRecordText(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const normalized = normalizeText(record[key]);
    if (normalized) {
      return normalized;
    }

    const numericIdentifier = stringifyIdentifier(record[key]);
    if (numericIdentifier) {
      return numericIdentifier;
    }
  }

  return null;
}

function readPositiveIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.floor(value) : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }

  return null;
}

function readRecordPositiveInteger(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const parsed = readPositiveIntegerValue(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function readRecordBoolean(record: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') {
        return true;
      }

      if (normalized === 'false' || normalized === '0') {
        return false;
      }
    }
  }

  return null;
}

function toRegiondoRequestIdentifier(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

const TASK_SECONDARY_EVENT_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const REGIONDO_FORMATTED_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const TASK_REGIONDO_ITEM_DATE_TIME_KEYS = ['date_time', 'dateTime', 'event_date_time', 'eventDateTime'] as const;

function addOneUtcCalendarDay(dateParts: { year: number; month: number; day: number }): string {
  const nextDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + 1));
  return `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    nextDate.getUTCDate()
  ).padStart(2, '0')}`;
}

function buildTaskSecondaryRegiondoDateTime(task: DashboardTask, bookingData: Record<string, unknown>): string | null {
  const secondaryEventTime = readRecordText(bookingData, 'secondary_event_time', 'secondaryEventTime');
  if (!secondaryEventTime) {
    return null;
  }

  const secondaryMatch = TASK_SECONDARY_EVENT_TIME_PATTERN.exec(secondaryEventTime);
  if (!secondaryMatch) {
    throw new DashboardValidationError('Task booking_data.secondary_event_time must use HH:mm format.');
  }

  if (!task.eventDateTime) {
    throw new DashboardValidationError('Task event date/time is required before using secondary event time.');
  }

  const primaryRegiondoDateTime = formatRegiondoDateTime(task.eventDateTime);
  const primaryMatch = primaryRegiondoDateTime
    ? REGIONDO_FORMATTED_DATE_TIME_PATTERN.exec(primaryRegiondoDateTime)
    : null;

  if (!primaryMatch) {
    throw new DashboardValidationError('Task event date/time is invalid.');
  }

  const secondaryHours = Number(secondaryMatch[1]);
  const secondaryMinutes = Number(secondaryMatch[2]);
  const primaryHours = Number(primaryMatch[4]);
  const primaryMinutes = Number(primaryMatch[5]);
  const primarySeconds = Number(primaryMatch[6]);
  const secondaryTotalSeconds = secondaryHours * 60 * 60 + secondaryMinutes * 60;
  const primaryTotalSeconds = primaryHours * 60 * 60 + primaryMinutes * 60 + primarySeconds;
  const primaryDate = {
    year: Number(primaryMatch[1]),
    month: Number(primaryMatch[2]),
    day: Number(primaryMatch[3])
  };
  const regiondoDate =
    secondaryTotalSeconds <= primaryTotalSeconds
      ? addOneUtcCalendarDay(primaryDate)
      : `${primaryMatch[1]}-${primaryMatch[2]}-${primaryMatch[3]}`;

  return `${regiondoDate} ${secondaryMatch[1]}:${secondaryMatch[2]}:00`;
}

function hasExplicitTaskRegiondoCartItemDateTime(item: Record<string, unknown>): boolean {
  return readRecordText(item, ...TASK_REGIONDO_ITEM_DATE_TIME_KEYS) !== null;
}

function buildTaskRegiondoCartItem(
  item: Record<string, unknown>,
  index: number,
  defaultQuantity: number
): RegiondoCheckoutCartItem {
  const productId = readRecordText(item, 'product_id', 'productId', 'id');
  if (!productId) {
    throw new DashboardValidationError(`Task booking_data.options[${index}] is missing product_id.`);
  }

  const quantity = readRecordPositiveInteger(item, 'qty', 'quantity') ?? defaultQuantity;
  const optionId = readRecordText(
    item,
    'option_id',
    'optionId',
    'variation_id',
    'variationId',
    'variant_id',
    'variantId'
  );
  const externalItemId = readRecordText(item, 'external_item_id', 'externalItemId', 'external_id', 'externalId');
  const reservationCode = readRecordText(item, 'reservation_code', 'reservationCode');
  const dateTime = readRecordText(item, 'date_time', 'dateTime', 'event_date_time', 'eventDateTime');
  const startDate = readRecordText(item, 'start_date', 'startDate');
  const endDate = readRecordText(item, 'end_date', 'endDate');
  const normalizedDateTime = dateTime ? formatRegiondoDateTime(dateTime) : null;

  if (dateTime && !normalizedDateTime) {
    throw new DashboardValidationError(`Task booking_data.options[${index}] has an invalid date_time.`);
  }

  let value: string | number | null | undefined = undefined;
  const rawValue = item.value ?? item.value_id ?? item.valueId ?? item.option_value ?? item.optionValue;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    value = rawValue;
  } else if (typeof rawValue === 'string' && rawValue.trim()) {
    value = rawValue.trim();
  } else if (rawValue === null) {
    value = null;
  }

  return {
    ...(normalizedDateTime ? { date_time: normalizedDateTime } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(externalItemId ? { external_item_id: externalItemId } : {}),
    ...(optionId ? { option_id: toRegiondoRequestIdentifier(optionId) } : {}),
    product_id: toRegiondoRequestIdentifier(productId),
    qty: quantity,
    ...(reservationCode ? { reservation_code: reservationCode } : {}),
    ...(startDate ? { start_date: startDate } : {}),
    ...(value !== undefined ? { value } : {})
  };
}

function buildTaskRegiondoContactData(task: DashboardTask, bookingData: Record<string, unknown>): RegiondoCheckoutContactData {
  const bookingContact = isRecord(bookingData.contact_data)
    ? bookingData.contact_data
    : isRecord(bookingData.contactData)
      ? bookingData.contactData
      : null;

  const firstname =
    readRecordText(bookingContact, 'firstname', 'first_name', 'firstName') ??
    readRecordText(bookingData, 'first_name', 'firstName') ??
    readTaskRawText(task, 'first_name');
  const lastname =
    readRecordText(bookingContact, 'lastname', 'last_name', 'lastName') ??
    readRecordText(bookingData, 'last_name', 'lastName') ??
    readTaskRawText(task, 'last_name');
  const contactEmail =
    readRecordText(bookingContact, 'email') ?? readRecordText(bookingData, 'email') ?? readTaskRawText(task, 'email');
  const sendRegiondoBookingsToAlternateEmail =
    readRecordBoolean(
      bookingData,
      'send_regiondo_bookings_to_alternate_email',
      'sendRegiondoBookingsToAlternateEmail'
    ) ?? false;
  const alternateRegiondoEmail = readRecordText(bookingData, 'regiondo_booking_email', 'regiondoBookingEmail');
  const email = sendRegiondoBookingsToAlternateEmail ? alternateRegiondoEmail : contactEmail;
  const telephone =
    readRecordText(bookingContact, 'telephone', 'phone_number', 'phoneNumber') ??
    readRecordText(bookingData, 'phone_number', 'phoneNumber') ??
    readTaskRawText(task, 'phone_number');

  if (sendRegiondoBookingsToAlternateEmail && !alternateRegiondoEmail) {
    throw new DashboardValidationError(
      'Task booking_data.regiondo_booking_email is required when alternate Regiondo email is enabled.'
    );
  }

  if (!firstname || !lastname || !email) {
    throw new DashboardValidationError(
      'Task contact data must include first name, last name, and email before creating a Regiondo booking.'
    );
  }

  return {
    email,
    firstname,
    lastname,
    ...(telephone ? { telephone } : {})
  };
}

function buildTaskRegiondoBookingPayload(task: DashboardTask): TaskRegiondoBookingPayload {
  const bookingData = readTaskBookingData(task);
  if (!bookingData) {
    throw new DashboardValidationError('Task raw_json.booking_data is required before creating a Regiondo booking.');
  }

  const cartItemsSource = Array.isArray(bookingData.options)
    ? bookingData.options
    : Array.isArray(bookingData.products)
      ? bookingData.products
      : Array.isArray(bookingData.items)
        ? bookingData.items
        : [];
  const defaultQuantity = readRecordPositiveInteger(bookingData, 'qty', 'quantity') ?? 1;
  const defaultExternalItemId = readRecordText(bookingData, 'external_item_id', 'externalItemId');
  const secondaryDateTime = buildTaskSecondaryRegiondoDateTime(task, bookingData);

  const items = cartItemsSource.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }

    const defaultDateTime = index === 1 && secondaryDateTime ? secondaryDateTime : task.eventDateTime;
    const hasExplicitDateTime = hasExplicitTaskRegiondoCartItemDateTime(entry);

    return [
      buildTaskRegiondoCartItem(
        {
          ...entry,
          ...(defaultExternalItemId ? { external_item_id: defaultExternalItemId } : {}),
          ...(defaultDateTime && !hasExplicitDateTime ? { date_time: defaultDateTime } : {})
        },
        index,
        defaultQuantity
      )
    ];
  });

  if (!items.length) {
    throw new DashboardValidationError('Task booking_data.options must include at least one Regiondo cart item.');
  }

  const buyerData = Array.isArray(bookingData.buyer_data)
    ? bookingData.buyer_data
    : Array.isArray(bookingData.buyerData)
      ? bookingData.buyerData
      : [];
  const attendeeData = Array.isArray(bookingData.attendee_data)
    ? bookingData.attendee_data
    : Array.isArray(bookingData.attendeeData)
      ? bookingData.attendeeData
      : [];
  const comment = readRecordText(bookingData, 'comment') ?? normalizeText(task.description);
  const storeLocale = readRecordText(bookingData, 'store_locale', 'storeLocale');

  return {
    attendeeData,
    buyerData,
    comment,
    contactData: buildTaskRegiondoContactData(task, bookingData),
    items,
    sendTicketsToCustomer: readRecordBoolean(bookingData, 'send_tickets_to_customer', 'sendTicketsToCustomer') ?? false,
    storeLocale,
    subId: readRecordText(bookingData, 'sub_id', 'subId') ?? task.id,
    syncTicketsProcessing:
      readRecordBoolean(bookingData, 'sync_tickets_processing', 'syncTicketsProcessing') ?? true
  };
}

function extractRegiondoBookingKeysFromPurchase(purchaseData: Record<string, unknown>): string[] {
  const items = Array.isArray(purchaseData.items) ? purchaseData.items : [];
  const bookingKeys = Array.from(
    new Set(
      items.flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }

        const bookingKey = readRecordText(item, 'booking_key');
        return bookingKey ? [bookingKey] : [];
      })
    )
  );

  if (!bookingKeys.length) {
    throw new DashboardValidationError('Regiondo purchase did not return a booking key for the created order.');
  }

  return bookingKeys;
}

async function createRegiondoBookingsForTask(
  client: PoolClient,
  task: DashboardTask
): Promise<{ bookingIds: string[]; primaryBookingId: string }> {
  const purchasePayload = buildTaskRegiondoBookingPayload(task);
  const purchaseData = await regiondoClient.purchaseOrder({
    attendeeData: purchasePayload.attendeeData,
    buyerData: purchasePayload.buyerData,
    comment: purchasePayload.comment ?? undefined,
    contactData: purchasePayload.contactData,
    items: purchasePayload.items,
    sendTicketsToCustomer: purchasePayload.sendTicketsToCustomer,
    storeLocale: purchasePayload.storeLocale ?? undefined,
    subId: purchasePayload.subId,
    syncTicketsProcessing: purchasePayload.syncTicketsProcessing
  });
  const bookingKeys = extractRegiondoBookingKeysFromPurchase(purchaseData as unknown as Record<string, unknown>);
  const createdBookingIds: string[] = [];

  for (const bookingKey of bookingKeys) {
    const supplierBookings = await regiondoClient.listSupplierBookings({
      bookingKey,
      limit: 250
    });
    const normalizedBooking = normalizeRegiondoBookingImport({
      bookingKey,
      purchaseData,
      supplierBookings,
      webhookPayload: null
    });
    const { bookingId } = await upsertNormalizedRegiondoBooking(client, normalizedBooking);
    createdBookingIds.push(bookingId);
  }

  return {
    bookingIds: createdBookingIds,
    primaryBookingId: createdBookingIds[0]
  };
}

async function seedBookingNotesFromTaskDescription(
  client: PoolClient,
  task: DashboardTask,
  bookingIds: string[]
): Promise<void> {
  const taskDescription = normalizeText(task.description);
  if (!taskDescription || !bookingIds.length) {
    return;
  }

  await client.query(
     `INSERT INTO booking_admin_metadata (booking_id, ops_status, ops_notes)
     SELECT booking_id, 'normal', $2
     FROM unnest($1::uuid[]) AS booking_ids(booking_id)
     ON CONFLICT (booking_id)
     DO UPDATE SET ops_notes = CASE
       WHEN EXCLUDED.ops_notes = '' THEN booking_admin_metadata.ops_notes
       WHEN booking_admin_metadata.ops_notes = '' THEN EXCLUDED.ops_notes
       WHEN position(EXCLUDED.ops_notes in booking_admin_metadata.ops_notes) > 0 THEN booking_admin_metadata.ops_notes
       ELSE booking_admin_metadata.ops_notes || E'\n' || EXCLUDED.ops_notes
     END`,
    [bookingIds, taskDescription]
  );
}

function decodeSelectionNodeValue(value: string): string[] {
  return value.split(':').map((segment) => decodeURIComponent(segment));
}

function normalizeManualContactField(manual: Record<string, unknown> | null, field: 'email' | 'firstName' | 'lastName' | 'phoneNumber'): string | null {
  if (!manual) {
    return null;
  }

  const contact = manual.contact;
  if (!isRecord(contact)) {
    return null;
  }

  return normalizeText(contact[field]);
}

function normalizeManualSelections(manual: Record<string, unknown> | null): DashboardBookingRegiondoSelection[] {
  if (!manual || !Array.isArray(manual.regiondoSelections)) {
    return [];
  }

  return manual.regiondoSelections.flatMap((selection, index) => {
    if (!isRecord(selection)) {
      return [];
    }

    const productTitle = normalizeText(selection.productTitle) ?? 'Product';
    const quantityValue = selection.quantity;
    const quantity =
      typeof quantityValue === 'number'
        ? quantityValue
        : typeof quantityValue === 'string'
          ? Number(quantityValue)
          : NaN;

    return [
      {
        id: stringifyIdentifier(selection.id) ?? `manual-selection-${index + 1}`,
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1,
        productId: stringifyIdentifier(selection.productId),
        regiondoProductId: stringifyIdentifier(selection.regiondoProductId),
        productTitle,
        variationLabel: normalizeText(selection.variationLabel),
        optionValueLabel: normalizeText(selection.optionValueLabel)
      }
    ] satisfies DashboardBookingRegiondoSelection[];
  });
}

function resolveTaskBookingEndDateTime(task: DashboardTask): string {
  const eventDateTime = task.eventDateTime;
  if (!eventDateTime) {
    throw new DashboardValidationError('Task event date/time is required before creating a booking.');
  }

  const start = new Date(eventDateTime);
  if (Number.isNaN(start.getTime())) {
    throw new DashboardValidationError('Task event date/time is invalid.');
  }

  const bookingData = readTaskBookingData(task);
  const secondaryEventTime =
    readRecordText(bookingData, 'secondary_event_time', 'secondaryEventTime') ?? readTaskRawText(task, 'secondary_event_time');
  if (secondaryEventTime && /^\d{2}:\d{2}$/.test(secondaryEventTime)) {
    const [hours, minutes] = secondaryEventTime.split(':').map((value) => Number(value));
    const end = new Date(start);
    end.setHours(hours, minutes, 0, 0);

    if (end.getTime() <= start.getTime()) {
      end.setDate(end.getDate() + 1);
    }

    return end.toISOString();
  }

  const end = new Date(start);
  end.setHours(end.getHours() + 2);
  return end.toISOString();
}

function createTaskBookingActivityLog(
  task: DashboardTask,
  bookingId: string,
  actor?: DashboardTaskMutationActor
): DashboardTaskActivityEntry[] {
  return [
    {
      id: `task-activity-${randomUUID()}`,
      actor:
        actor?.name && actor.role
          ? { name: actor.name, role: actor.role, source: actor.source ?? 'user' }
          : { name: 'System', role: 'Operations', source: 'system' },
      changes: [
        {
          field: 'connectedBookingId',
          ...(task.connectedBookingId ? { from: task.connectedBookingId } : {}),
          to: bookingId
        }
      ],
      occurredAt: new Date().toISOString(),
      type: 'updated'
    },
    ...task.activityLog
  ];
}

async function queryTaskForBookingCreation(executor: Queryable, taskId: string, forUpdate = false): Promise<TaskRow | null> {
  const result = await executor.query<TaskRow>(
    `${TASK_SELECT_QUERY}
     WHERE t.id = $1 AND t.is_deleted = false
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    [taskId]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function resolveTaskBookingLocation(executor: Queryable, site: string): Promise<TaskBookingLocationRow> {
  const normalizedSite = site.trim();
  if (!normalizedSite) {
    throw new DashboardValidationError('Task location is required before creating a booking.');
  }

  const result = await executor.query<TaskBookingLocationRow>(
    `SELECT location_id, title, regiondo_location_id
     FROM locations
     WHERE LOWER(title) = LOWER($1)
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalizedSite]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('Task location must match an internal location before creating a booking.');
  }

  if (result.rows[0].regiondo_location_id === SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID) {
    throw new DashboardValidationError('Task location must use an internal location before creating a booking.');
  }

  return result.rows[0];
}

async function upsertTaskBookingClient(executor: Queryable, task: DashboardTask): Promise<string> {
  const firstName = readTaskRawText(task, 'first_name') ?? 'Unknown';
  const lastName = readTaskRawText(task, 'last_name') ?? 'Client';
  const email = readTaskRawText(task, 'email');
  const phoneNumber = readTaskRawText(task, 'phone_number');
  const raw = JSON.stringify({
    source: 'manual_task',
    taskId: task.id,
    contact: {
      email,
      firstName,
      lastName,
      phoneNumber
    }
  });

  if (email) {
    const result = await executor.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, email, phone_number, regiondo_raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (email)
       DO UPDATE SET first_name = EXCLUDED.first_name,
                     last_name = EXCLUDED.last_name,
                     phone_number = COALESCE(EXCLUDED.phone_number, clients.phone_number),
                     regiondo_raw = EXCLUDED.regiondo_raw,
                     updated_at = now()
       RETURNING client_id`,
      [firstName, lastName, email, phoneNumber, raw]
    );

    return result.rows[0].client_id;
  }

  const result = await executor.query<{ client_id: string }>(
    `INSERT INTO clients (first_name, last_name, phone_number, regiondo_raw)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING client_id`,
    [firstName, lastName, phoneNumber, raw]
  );

  return result.rows[0].client_id;
}

async function resolveTaskBookingSelection(
  executor: Queryable,
  valuePath: string[]
): Promise<TaskBookingResolvedSelection | null> {
  if (!valuePath.length) {
    return null;
  }

  const [productNode, levelOneNode, levelTwoNode, levelThreeNode] = valuePath;
  const [productKind, productKey] = decodeSelectionNodeValue(productNode);

  if (productKind !== 'product' || !productKey) {
    return null;
  }

  const productResult = await executor.query<TaskBookingProductRow>(
    `SELECT product_id, title, base_amount, regiondo_product_id
     FROM products
     WHERE product_id::text = $1 OR regiondo_product_id = $1
     LIMIT 1`,
    [productKey]
  );

  if (!productResult.rowCount) {
    return null;
  }

  const product = productResult.rows[0];
  let unitPrice = Number(product.base_amount);
  let variationLabel: string | null = null;
  let optionValueLabel: string | null = null;
  let variationId: string | null = null;
  let optionNode: string | undefined;
  let optionValueNode: string | undefined;

  if (levelOneNode) {
    const [levelOneKind, , decodedVariationId, decodedOptionId] = decodeSelectionNodeValue(levelOneNode);

    if (levelOneKind === 'variant' && decodedVariationId) {
      variationId = decodedVariationId;
      optionNode = levelTwoNode;
      optionValueNode = levelThreeNode;
    } else {
      optionNode = levelOneNode;
      optionValueNode = levelTwoNode;

      if (levelOneKind === 'option' && decodedOptionId) {
        variationId = decodedOptionId;
      }
    }
  }

  if (variationId) {
    const variationResult = await executor.query<TaskBookingVariantRow>(
      `SELECT title, price
       FROM product_variants
       WHERE regiondo_variant_id = $1
       LIMIT 1`,
      [variationId]
    );

    if (variationResult.rowCount) {
      variationLabel = normalizeText(variationResult.rows[0].title) ?? variationId;
      const variantPrice = variationResult.rows[0].price;
      const parsedVariantPrice =
        typeof variantPrice === 'number'
          ? variantPrice
          : typeof variantPrice === 'string'
            ? Number(variantPrice)
            : NaN;

      if (Number.isFinite(parsedVariantPrice)) {
        unitPrice = parsedVariantPrice;
      }
    } else {
      variationLabel = variationId;
    }
  }

  if (optionNode) {
    const decodedOptionNode = decodeSelectionNodeValue(optionNode);
    const optionNodeKind = decodedOptionNode[0];
    const optionNodeVariationId = decodedOptionNode.length >= 4 ? decodedOptionNode[2] : null;
    const optionId = decodedOptionNode.length >= 4 ? decodedOptionNode[3] : decodedOptionNode[2];
    const resolvedVariationId = variationId ?? optionNodeVariationId;

    if (optionNodeKind === 'option' && optionId) {
      const optionResult = await executor.query<TaskBookingOptionRow>(
        `SELECT title, values_json
         FROM product_options
         WHERE regiondo_product_id = $1
           AND regiondo_option_id = $2
           AND ($3::text IS NULL OR regiondo_variant_id = $3)
         ORDER BY CASE WHEN regiondo_variant_id = $3 THEN 0 ELSE 1 END, regiondo_variant_id NULLS LAST
         LIMIT 1`,
        [product.regiondo_product_id, optionId, resolvedVariationId]
      );

      const optionTitle = optionResult.rowCount ? normalizeText(optionResult.rows[0].title) ?? optionId : optionId;

      if (!optionValueNode) {
        optionValueLabel = optionTitle;
      } else {
        const decodedValueNode = decodeSelectionNodeValue(optionValueNode);
        const valueKind = decodedValueNode[0];
        const valueId = decodedValueNode.length >= 5 ? decodedValueNode[4] : decodedValueNode[3];

        if (valueKind === 'option-value' && valueId) {
          if (optionResult.rowCount && Array.isArray(optionResult.rows[0].values_json)) {
            const matchingValue = optionResult.rows[0].values_json.find((entry) => {
              if (!isRecord(entry)) {
                return false;
              }

              return normalizeText(entry.id) === valueId || normalizeText(entry.label) === valueId;
            });

            if (isRecord(matchingValue)) {
              optionValueLabel = normalizeText(matchingValue.label) ?? normalizeText(matchingValue.id) ?? valueId;
            } else {
              optionValueLabel = valueId;
            }
          } else {
            optionValueLabel = valueId;
          }
        }
      }
    }
  }

  return {
    productId: product.product_id,
    productTitle: product.title,
    quantity: 1,
    regiondoProductId: product.regiondo_product_id,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    valuePath,
    variationLabel,
    optionValueLabel
  };
}

function findMatchingBookingProduct(
  products: DashboardBookingProduct[],
  input: { regiondoProductId: string | null; productTitle: string | null }
): DashboardBookingProduct | null {
  if (input.regiondoProductId) {
    const matchByRegiondoId = products.find((product) => product.regiondoProductId === input.regiondoProductId);
    if (matchByRegiondoId) {
      return matchByRegiondoId;
    }
  }

  if (input.productTitle) {
    const lookupTitle = input.productTitle.trim().toLowerCase();
    const matchByTitle = products.find((product) => product.title.trim().toLowerCase() === lookupTitle);
    if (matchByTitle) {
      return matchByTitle;
    }
  }

  return null;
}

function extractPhoneNumber(rawValue: unknown, fallbackPhoneNumber: string | null): string | null {
  const manual = getManualRecord(rawValue);
  const purchaseData = getPurchaseDataRecord(rawValue);
  const purchaseContactData = purchaseData && isRecord(purchaseData.contact_data) ? purchaseData.contact_data : null;

  return (
    normalizeManualContactField(manual, 'phoneNumber') ??
    normalizeText(purchaseContactData?.telephone) ??
    normalizeText(purchaseContactData?.phone_number) ??
    fallbackPhoneNumber
  );
}

function extractPaymentMethod(rawValue: unknown): string | null {
  const manual = getManualRecord(rawValue);
  if (manual) {
    const payment = manual.payment;
    if (isRecord(payment)) {
      const manualPaymentMethod = normalizeText(payment.paymentMethod);
      if (manualPaymentMethod) {
        return manualPaymentMethod;
      }
    }
  }

  const purchaseData = getPurchaseDataRecord(rawValue);
  return purchaseData ? normalizeText(purchaseData.payment_method) : null;
}

function extractRegiondoSelections(
  rawValue: unknown,
  products: DashboardBookingProduct[]
): DashboardBookingRegiondoSelection[] {
  const manualSelections = normalizeManualSelections(getManualRecord(rawValue));
  if (manualSelections.length) {
    return manualSelections;
  }

  const purchaseData = getPurchaseDataRecord(rawValue);
  if (!purchaseData || !Array.isArray(purchaseData.items)) {
    return [];
  }

  return purchaseData.items.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }

    const regiondoProductId = stringifyIdentifier(item.product_id);
    const productTitle =
      normalizeText(item.product_name) ??
      normalizeText(item.ticket_name) ??
      normalizeText(item.external_id) ??
      "Product";
    const matchedProduct = findMatchingBookingProduct(products, {
      regiondoProductId,
      productTitle
    });
    const quantityValue =
      typeof item.ticket_qty === "number"
        ? item.ticket_qty
        : typeof item.ticket_qty === "string"
          ? Number(item.ticket_qty)
          : NaN;

    return [
      {
        id: `regiondo-selection-${index + 1}`,
        quantity: Number.isFinite(quantityValue) && quantityValue > 0 ? Math.floor(quantityValue) : 1,
        productId: matchedProduct?.productId ?? null,
        regiondoProductId: regiondoProductId ?? matchedProduct?.regiondoProductId ?? null,
        productTitle: matchedProduct?.title ?? productTitle,
        variationLabel: normalizeText(item.ticket_variation),
        optionValueLabel: normalizeText(item.ticket_option)
      }
    ] satisfies DashboardBookingRegiondoSelection[];
  });
}

function buildBookingDrawerData(row: BookingRow, products: DashboardBookingProduct[]): DashboardBookingDrawerData {
  const amountToPay = Number(row.total_amount);
  const amountPaid = Number(row.paid_amount);

  return {
    contact: {
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phoneNumber: extractPhoneNumber(row.booking_raw, row.phone_number)
    },
    payment: {
      amountOutstanding: Math.max(0, amountToPay - amountPaid),
      amountPaid,
      amountToPay,
      paymentMethod: extractPaymentMethod(row.booking_raw)
    },
    regiondoSelections: extractRegiondoSelections(row.booking_raw, products)
  };
}

function buildBookingBaseQuery() {
  return `SELECT
       b.booking_id AS id,
       b.status,
       b.guest_count,
       b.total_amount,
       b.paid_amount,
       b.dt_from,
       b.dt_to,
       b.source,
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
       COALESCE(
         NULLIF(b.regiondo_raw #>> '{provider,purchaseData,contact_data,telephone}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,contact_data,telephone}', ''),
         NULLIF(b.regiondo_raw #>> '{provider,supplierBookings,0,phone_number}', ''),
         c.phone_number
       ) AS phone_number,
       product_lookup.primary_product_title AS product_title,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       c.regiondo_customer_id AS client_regiondo_customer_id,
       location.location_id,
       location.title AS location_title,
       location.regiondo_location_id AS location_regiondo_location_id,
       admin.location_override,
       admin.last_provider_edit_error,
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
       p.regiondo_product_id,
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
    regiondoProductId: row.regiondo_product_id,
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
       admin.last_provider_edit_error,
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
     LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
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
    lastProviderEditError: row.last_provider_edit_error,
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

export async function createBookingFromTask(
  taskId: string,
  actor?: DashboardTaskMutationActor
): Promise<{ bookingId: string }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const taskRow = await queryTaskForBookingCreation(client, taskId, true);

    if (!taskRow) {
      throw new DashboardNotFoundError('Task not found.');
    }

    const task = mapTaskRow(taskRow);

    if (task.connectedBookingId) {
      throw new DashboardValidationError('Task is already linked to a booking.');
    }

    if (!canCreateBookingFromTaskColumnPosition(task.columnPosition)) {
      throw new DashboardValidationError('Bookings can only be created from the configured confirmation columns.');
    }

    const { bookingIds, primaryBookingId } = await createRegiondoBookingsForTask(client, task);
    await seedBookingNotesFromTaskDescription(client, task, bookingIds);

    await client.query(
      `UPDATE tasks
       SET update_log = $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(createTaskBookingActivityLog(task, primaryBookingId, actor)), task.id]
    );
    await appendTaskBookingLinks(client, {
      taskId: task.id,
      bookingIds,
      primaryBookingId
    });

    await client.query('COMMIT');
    return { bookingId: primaryBookingId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getBooking(bookingId: string): Promise<DashboardBookingDetail> {
  const row = await queryBookingRow(pool, bookingId);
  if (!row) {
    throw new DashboardNotFoundError("Booking not found.");
  }

  const [products, sync] = await Promise.all([queryBookingProducts(pool, bookingId), getBookingSync(bookingId)]);

  return {
    ...mapBookingRow(row),
    drawerData: buildBookingDrawerData(row, products),
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
         AND log.action IN ('admin.booking.updated', 'dashboard.booking.updated', 'dashboard.booking.reconciled')
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

function normalizeBookingText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requireBookingText(value: string | null | undefined, fieldName: string): string {
  const normalized = normalizeBookingText(value);
  if (!normalized) {
    throw new DashboardValidationError(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeMoney(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DashboardValidationError(`${fieldName} must be a positive amount.`);
  }

  return Math.round(value * 100) / 100;
}

function readStoredMoney(value: string | number, fieldName: string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(normalized)) {
    throw new DashboardValidationError(`${fieldName} is invalid.`);
  }

  return normalizeMoney(normalized, fieldName);
}

function compareMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

function normalizeUpdateDate(value: string, fieldName: string): string {
  return toIsoStringOrThrow(value, fieldName);
}

function resolveBookingDateRange(current: BookingForUpdateRow, input: UpdateDashboardBookingInput) {
  const currentStart = requireIsoString(current.dt_from, 'bookings.dt_from');
  const currentEnd = requireIsoString(current.dt_to, 'bookings.dt_to');
  const nextStart = input.bookingDate ? normalizeUpdateDate(input.bookingDate, 'bookingDate') : currentStart;
  let nextEnd = input.bookingEndDate ? normalizeUpdateDate(input.bookingEndDate, 'bookingEndDate') : currentEnd;

  if (input.bookingDate && !input.bookingEndDate) {
    const currentDurationMs = new Date(currentEnd).getTime() - new Date(currentStart).getTime();
    const durationMs = currentDurationMs > 0 ? currentDurationMs : 2 * 60 * 60 * 1000;
    nextEnd = new Date(new Date(nextStart).getTime() + durationMs).toISOString();
  }

  if (new Date(nextEnd).getTime() <= new Date(nextStart).getTime()) {
    throw new DashboardValidationError('bookingEndDate must be after bookingDate.');
  }

  return {
    changed: nextStart !== currentStart || nextEnd !== currentEnd,
    currentEnd,
    currentStart,
    nextEnd,
    nextStart
  };
}

function resolveBookingContact(current: BookingForUpdateRow, input: UpdateDashboardBookingInput) {
  const manual = getManualRecord(current.regiondo_raw);
  const currentContact = {
    email: normalizeManualContactField(manual, 'email') ?? normalizeBookingText(current.email),
    firstName: normalizeManualContactField(manual, 'firstName') ?? normalizeBookingText(current.first_name) ?? 'Unknown',
    lastName: normalizeManualContactField(manual, 'lastName') ?? normalizeBookingText(current.last_name) ?? 'Unknown',
    phoneNumber: normalizeManualContactField(manual, 'phoneNumber') ?? normalizeBookingText(current.phone_number)
  };

  const nextContact = {
    email: input.contact && 'email' in input.contact ? normalizeBookingText(input.contact.email ?? null) : currentContact.email,
    firstName:
      input.contact && 'firstName' in input.contact
        ? requireBookingText(input.contact.firstName, 'contact.firstName')
        : currentContact.firstName,
    lastName:
      input.contact && 'lastName' in input.contact
        ? requireBookingText(input.contact.lastName, 'contact.lastName')
        : currentContact.lastName,
    phoneNumber:
      input.contact && 'phoneNumber' in input.contact
        ? normalizeBookingText(input.contact.phoneNumber ?? null)
        : currentContact.phoneNumber
  };

  return {
    changed:
      nextContact.email !== currentContact.email ||
      nextContact.firstName !== currentContact.firstName ||
      nextContact.lastName !== currentContact.lastName ||
      nextContact.phoneNumber !== currentContact.phoneNumber,
    current: currentContact,
    next: nextContact
  };
}

function resolveBookingPayment(current: BookingForUpdateRow, input: UpdateDashboardBookingInput) {
  const currentPayment = {
    amountPaid: readStoredMoney(current.paid_amount, 'bookings.paid_amount'),
    amountToPay: readStoredMoney(current.total_amount, 'bookings.total_amount'),
    paymentMethod: extractPaymentMethod(current.regiondo_raw)
  };
  const nextPayment = {
    amountPaid:
      input.payment && input.payment.amountPaid !== undefined
        ? normalizeMoney(input.payment.amountPaid, 'payment.amountPaid')
        : currentPayment.amountPaid,
    amountToPay:
      input.payment && input.payment.amountToPay !== undefined
        ? normalizeMoney(input.payment.amountToPay, 'payment.amountToPay')
        : currentPayment.amountToPay,
    paymentMethod:
      input.payment && 'paymentMethod' in input.payment
        ? normalizeBookingText(input.payment.paymentMethod ?? null)
        : currentPayment.paymentMethod
  };

  if (input.payment && nextPayment.amountPaid > nextPayment.amountToPay) {
    throw new DashboardValidationError('payment.amountPaid cannot exceed payment.amountToPay.');
  }

  return {
    changed:
      !compareMoney(nextPayment.amountPaid, currentPayment.amountPaid) ||
      !compareMoney(nextPayment.amountToPay, currentPayment.amountToPay) ||
      nextPayment.paymentMethod !== currentPayment.paymentMethod,
    current: currentPayment,
    next: nextPayment
  };
}

async function ensureNoLocationPlaceholder(executor: Queryable): Promise<BookingLocationUpdateRow> {
  const result = await executor.query<BookingLocationUpdateRow>(
    `INSERT INTO locations (title, description, regiondo_location_id, regiondo_raw)
     VALUES ('No location', NULL, $1, $2::jsonb)
     ON CONFLICT (regiondo_location_id)
     DO UPDATE SET title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   regiondo_raw = EXCLUDED.regiondo_raw,
                   updated_at = now()
     RETURNING location_id, title, regiondo_location_id`,
    [SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID, JSON.stringify({ source: 'system', kind: 'no_location' })]
  );

  return result.rows[0];
}

async function resolveBookingLocationUpdate(
  executor: Queryable,
  current: BookingForUpdateRow,
  input: UpdateDashboardBookingInput
): Promise<{ changed: boolean; location: BookingLocationUpdateRow; locationOverride: BookingLocationOverride }> {
  if (input.locationId === null) {
    const location = await ensureNoLocationPlaceholder(executor);
    return {
      changed: location.location_id !== current.location_id || current.location_override !== 'none',
      location,
      locationOverride: 'none'
    };
  }

  const locationId = input.locationId === undefined ? current.location_id : input.locationId;
  if (!locationId) {
    throw new DashboardValidationError('locationId is required.');
  }

  const result = await executor.query<BookingLocationUpdateRow>(
    `SELECT location_id, title, regiondo_location_id
     FROM locations
     WHERE location_id = $1
     LIMIT 1`,
    [locationId]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('Selected location does not exist.');
  }

  const location = result.rows[0];
  if (input.locationId !== undefined && location.regiondo_location_id && SYSTEM_LOCATION_PROVIDER_IDS.has(location.regiondo_location_id)) {
    throw new DashboardValidationError('System location placeholders must be selected through the No location option.');
  }

  return {
    changed: location.location_id !== current.location_id || (input.locationId !== undefined && current.location_override === 'none'),
    location,
    locationOverride: input.locationId === undefined && current.location_override === 'none' ? 'none' : null
  };
}

async function resolveBookingProductUpdates(
  executor: Queryable,
  currentProducts: DashboardBookingProduct[],
  input: UpdateDashboardBookingInput
): Promise<{ changed: boolean; products: ResolvedBookingProductUpdate[] }> {
  if (!input.products) {
    return {
      changed: false,
      products: currentProducts.map((product) => ({
        productId: product.productId,
        quantity: product.quantity,
        regiondoProductId: product.regiondoProductId,
        title: product.title,
        unitPrice: product.unitPrice
      }))
    };
  }

  if (!input.products.length) {
    throw new DashboardValidationError('At least one product is required.');
  }

  const seenProductIds = new Set<string>();
  const products: ResolvedBookingProductUpdate[] = [];

  for (const productInput of input.products) {
    const productId = requireBookingText(productInput.productId, 'products.productId');
    if (seenProductIds.has(productId)) {
      throw new DashboardValidationError('Each product can only be selected once.');
    }
    seenProductIds.add(productId);

    if (!Number.isInteger(productInput.quantity) || productInput.quantity <= 0) {
      throw new DashboardValidationError('products.quantity must be a positive integer.');
    }

    const productResult = await executor.query<BookingProductUpdateRow>(
      `SELECT product_id, regiondo_product_id, title, base_amount
       FROM products
       WHERE product_id = $1
       LIMIT 1`,
      [productId]
    );

    if (!productResult.rowCount) {
      throw new DashboardValidationError('Selected product does not exist.');
    }

    const product = productResult.rows[0];
    const defaultUnitPrice = readStoredMoney(product.base_amount, 'products.base_amount');
    const unitPrice =
      productInput.unitPrice === undefined || productInput.unitPrice === null
        ? defaultUnitPrice
        : normalizeMoney(productInput.unitPrice, 'products.unitPrice');

    products.push({
      productId: product.product_id,
      quantity: productInput.quantity,
      regiondoProductId: product.regiondo_product_id,
      title: product.title,
      unitPrice
    });
  }

  const currentComparable = currentProducts
    .map((product) => `${product.productId}:${product.quantity}:${product.unitPrice.toFixed(2)}`)
    .sort()
    .join('|');
  const nextComparable = products
    .map((product) => `${product.productId}:${product.quantity}:${product.unitPrice.toFixed(2)}`)
    .sort()
    .join('|');

  return {
    changed: currentComparable !== nextComparable,
    products
  };
}

function resolveOpsMetadata(current: BookingForUpdateRow, input: UpdateDashboardBookingInput) {
  const currentOpsStatus: 'normal' | 'escalated' = current.ops_status === 'escalated' ? 'escalated' : 'normal';
  const nextOpsStatus: 'normal' | 'escalated' =
    input.opsStatus === 'Escalated'
      ? 'escalated'
      : input.opsStatus === 'Normal'
        ? 'normal'
        : currentOpsStatus;
  const currentOpsNotes = current.ops_notes ?? '';
  const nextOpsNotes = typeof input.opsNotes === 'string' ? input.opsNotes.trim() : currentOpsNotes;

  return {
    notesChanged: nextOpsNotes !== currentOpsNotes,
    statusChanged: nextOpsStatus !== currentOpsStatus,
    nextOpsNotes,
    nextOpsStatus
  };
}

function cloneBookingRaw(rawValue: unknown): Record<string, unknown> {
  if (!isRecord(rawValue)) {
    return {};
  }

  return JSON.parse(JSON.stringify(rawValue)) as Record<string, unknown>;
}

function buildManualBookingRaw(input: ResolvedBookingUpdate): Record<string, unknown> {
  const raw = cloneBookingRaw(input.raw);
  const manual = isRecord(raw.manual) ? { ...raw.manual } : {};
  manual.contact = input.contact;
  manual.payment = input.payment;
  manual.regiondoSelections = input.products.map((product, index) => ({
    id: `manual-selection-${index + 1}`,
    productId: product.productId,
    productTitle: product.title,
    quantity: product.quantity,
    regiondoProductId: product.regiondoProductId
  }));
  raw.manual = manual;
  raw.source = normalizeBookingText(raw.source as string | null | undefined) ?? 'manual_admin';
  return raw;
}

function mapPaymentMethodToType(paymentMethod: string | null): 'cash' | 'card' | 'paypal' | 'sepa' | 'bank_transfer' | 'voucher' | 'other' {
  const normalized = paymentMethod?.toLowerCase() ?? '';
  if (normalized.includes('paypal')) {
    return 'paypal';
  }
  if (normalized.includes('sepa')) {
    return 'sepa';
  }
  if (normalized.includes('bank') || normalized.includes('transfer') || normalized.includes('invoice')) {
    return 'bank_transfer';
  }
  if (normalized.includes('voucher') || normalized.includes('coupon')) {
    return 'voucher';
  }
  if (normalized.includes('cash') || normalized.includes('bar')) {
    return 'cash';
  }
  if (normalized.includes('card') || normalized.includes('karte')) {
    return 'card';
  }

  return 'other';
}

function buildRegiondoUpdateInput(
  current: BookingForUpdateRow,
  update: ResolvedBookingUpdate,
  changes: {
    attendees: boolean;
    contact: boolean;
    location: boolean;
    payment: boolean;
    products: boolean;
    schedule: boolean;
  }
): RegiondoUpdateBookingInput | null {
  if (!current.regiondo_booking_id) {
    return null;
  }

  const providerInput: RegiondoUpdateBookingInput = {
    bookingKey: current.regiondo_booking_id,
    orderNumber: current.regiondo_order_number
  };
  let hasProviderMutation = false;

  if (changes.contact) {
    providerInput.contactData = {
      ...(update.contact.email ? { email: update.contact.email } : {}),
      firstname: update.contact.firstName,
      lastname: update.contact.lastName,
      ...(update.contact.phoneNumber ? { telephone: update.contact.phoneNumber } : {})
    };
    hasProviderMutation = true;
  }

  if (changes.schedule) {
    const startsAt = formatRegiondoDateTime(update.dtFrom);
    const endsAt = formatRegiondoDateTime(update.dtTo);
    if (!startsAt || !endsAt) {
      throw new DashboardValidationError('Booking date/time is invalid for Regiondo.');
    }
    providerInput.startsAt = startsAt;
    providerInput.endsAt = endsAt;
    hasProviderMutation = true;
  }

  if (changes.attendees) {
    providerInput.guestCount = update.guestCount;
    hasProviderMutation = true;
  }

  if (changes.location) {
    if (!update.regiondoLocationId) {
      throw new DashboardValidationError('Selected location cannot be updated in Regiondo because it has no Regiondo location ID.');
    }
    providerInput.locationId = update.regiondoLocationId;
    hasProviderMutation = true;
  }

  if (changes.products) {
    const itemDateTime = formatRegiondoDateTime(update.dtFrom);
    if (!itemDateTime) {
      throw new DashboardValidationError('Booking date/time is invalid for Regiondo products.');
    }

    providerInput.items = update.products.map((product) => {
      if (!product.regiondoProductId) {
        throw new DashboardValidationError('Selected products must be synced with Regiondo before updating a Regiondo booking.');
      }

      return {
        date_time: itemDateTime,
        product_id: product.regiondoProductId,
        qty: product.quantity,
        unit_price: product.unitPrice
      } satisfies RegiondoCheckoutCartItem;
    });
    hasProviderMutation = true;
  }

  if (changes.payment) {
    providerInput.payment = {
      amountPaid: update.payment.amountPaid,
      amountToPay: update.payment.amountToPay,
      paymentMethod: update.payment.paymentMethod
    };
    hasProviderMutation = true;
  }

  return hasProviderMutation ? providerInput : null;
}

async function queryBookingForUpdate(executor: Queryable, bookingId: string): Promise<BookingForUpdateRow | null> {
  const result = await executor.query<BookingForUpdateRow>(
    `SELECT
       b.booking_id,
       b.client_id,
       b.location_id,
       b.status,
       b.guest_count,
       b.total_amount,
       b.paid_amount,
       b.dt_from,
       b.dt_to,
       b.source,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       b.regiondo_raw,
       b.updated_at,
       c.first_name,
       c.last_name,
       c.email::text AS email,
       c.phone_number,
       admin.ops_status,
       admin.ops_notes,
       admin.last_provider_edit_error,
       admin.location_override
     FROM bookings b
     INNER JOIN clients c ON c.client_id = b.client_id
     LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
     WHERE b.booking_id = $1
     LIMIT 1
     FOR UPDATE OF b, c`,
    [bookingId]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function assertClientEmailAvailable(executor: Queryable, clientId: string, email: string | null): Promise<void> {
  if (!email) {
    return;
  }

  const result = await executor.query<{ client_id: string }>(
    `SELECT client_id
     FROM clients
     WHERE email = $1
       AND client_id <> $2
     LIMIT 1`,
    [email, clientId]
  );

  if (result.rowCount) {
    throw new DashboardValidationError('Another client already uses this email address.');
  }
}

async function buildResolvedBookingUpdate(
  executor: Queryable,
  current: BookingForUpdateRow,
  currentProducts: DashboardBookingProduct[],
  input: UpdateDashboardBookingInput
): Promise<ResolvedBookingUpdate> {
  if (input.expectedLastUpdated) {
    const expectedLastUpdated = toIsoStringOrThrow(input.expectedLastUpdated, 'expectedLastUpdated');
    const currentLastUpdated = requireIsoString(current.updated_at, 'bookings.updated_at');
    if (expectedLastUpdated !== currentLastUpdated) {
      throw new DashboardValidationError('Booking was updated by another process. Reload before saving.');
    }
  }

  const dateRange = resolveBookingDateRange(current, input);
  const contact = resolveBookingContact(current, input);
  await assertClientEmailAvailable(executor, current.client_id, contact.next.email);
  const payment = resolveBookingPayment(current, input);
  const location = await resolveBookingLocationUpdate(executor, current, input);
  const products = await resolveBookingProductUpdates(executor, currentProducts, input);
  const ops = resolveOpsMetadata(current, input);
  const guestCount = input.attendees === undefined ? current.guest_count : input.attendees;
  if (!Number.isInteger(guestCount) || guestCount <= 0) {
    throw new DashboardValidationError('attendees must be a positive integer.');
  }

  const attendeeChanged = guestCount !== current.guest_count;
  const changedFields = [
    ...(contact.changed ? ['contact'] : []),
    ...(dateRange.changed ? ['schedule'] : []),
    ...(attendeeChanged ? ['attendees'] : []),
    ...(location.changed ? ['location'] : []),
    ...(products.changed ? ['products'] : []),
    ...(payment.changed ? ['payment'] : []),
    ...(ops.statusChanged ? ['opsStatus'] : []),
    ...(ops.notesChanged ? ['opsNotes'] : [])
  ];
  const isRegiondoBooking = current.source === 'regiondo' || Boolean(current.regiondo_booking_id);
  const resolved: ResolvedBookingUpdate = {
    changedFields,
    clearProviderEditError: !isRegiondoBooking,
    contact: contact.next,
    dtFrom: dateRange.nextStart,
    dtTo: dateRange.nextEnd,
    guestCount,
    locationId: location.location.location_id,
    locationOverride: location.locationOverride,
    opsNotes: ops.nextOpsNotes,
    opsStatus: ops.nextOpsStatus,
    payment: payment.next,
    products: products.products,
    providerInput: null,
    raw: current.regiondo_raw,
    regiondoLocationId: location.location.regiondo_location_id,
    rebuildConsumptions: dateRange.changed || products.changed
  };

  resolved.providerInput = buildRegiondoUpdateInput(current, resolved, {
    attendees: attendeeChanged,
    contact: contact.changed,
    location: location.changed && location.locationOverride !== 'none',
    payment: payment.changed,
    products: products.changed,
    schedule: dateRange.changed
  });
  resolved.clearProviderEditError = resolved.clearProviderEditError || Boolean(resolved.providerInput);

  return resolved;
}

async function upsertBookingAdminMetadata(
  executor: Queryable,
  bookingId: string,
  input: {
    lastProviderEditError: string | null;
    locationOverride: BookingLocationOverride;
    opsNotes: string;
    opsStatus: 'normal' | 'escalated';
  }
): Promise<void> {
  await executor.query(
    `INSERT INTO booking_admin_metadata (booking_id, ops_status, ops_notes, last_provider_edit_error, location_override)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id)
     DO UPDATE SET ops_status = EXCLUDED.ops_status,
                   ops_notes = EXCLUDED.ops_notes,
                   last_provider_edit_error = EXCLUDED.last_provider_edit_error,
                   location_override = EXCLUDED.location_override,
                   updated_at = now()`,
    [bookingId, input.opsStatus, input.opsNotes, input.lastProviderEditError, input.locationOverride]
  );
}

async function recordBookingProviderEditError(bookingId: string, message: string): Promise<void> {
  await pool.query(
    `INSERT INTO booking_admin_metadata (booking_id, last_provider_edit_error)
     VALUES ($1, $2)
     ON CONFLICT (booking_id)
     DO UPDATE SET last_provider_edit_error = EXCLUDED.last_provider_edit_error,
                   updated_at = now()`,
    [bookingId, message]
  );
}

function getProviderEditErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Regiondo booking update failed.';
}

async function updateManualBooking(
  executor: Queryable,
  bookingId: string,
  current: BookingForUpdateRow,
  update: ResolvedBookingUpdate,
  updateProducts: boolean,
  updatePayment: boolean
): Promise<void> {
  await executor.query(
    `UPDATE clients
     SET first_name = $2,
         last_name = $3,
         email = $4,
         phone_number = $5,
         updated_at = now()
     WHERE client_id = $1`,
    [current.client_id, update.contact.firstName, update.contact.lastName, update.contact.email, update.contact.phoneNumber]
  );

  await executor.query(
    `UPDATE bookings
     SET location_id = $2,
         guest_count = $3,
         total_amount = $4,
         paid_amount = $5,
         dt_from = $6::timestamptz,
         dt_to = $7::timestamptz,
         regiondo_raw = $8::jsonb,
         updated_at = now()
     WHERE booking_id = $1`,
    [
      bookingId,
      update.locationId,
      update.guestCount,
      update.payment.amountToPay,
      update.payment.amountPaid,
      update.dtFrom,
      update.dtTo,
      JSON.stringify(buildManualBookingRaw(update))
    ]
  );

  if (updateProducts) {
    await executor.query('DELETE FROM booking_products WHERE booking_id = $1', [bookingId]);
    for (const product of update.products) {
      await executor.query(
        `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, product.productId, product.quantity, product.unitPrice]
      );
    }
  }

  if (updatePayment) {
    await executor.query('DELETE FROM payments WHERE booking_id = $1', [bookingId]);
    if (update.payment.amountPaid > 0) {
      await executor.query(
        `INSERT INTO payments (booking_id, amount, type, provider_ref)
         VALUES ($1, $2, $3, NULL)`,
        [bookingId, update.payment.amountPaid, mapPaymentMethodToType(update.payment.paymentMethod)]
      );
    }
  }
}

async function applyBookingLocationOverride(
  executor: Queryable,
  bookingId: string,
  update: ResolvedBookingUpdate
): Promise<void> {
  if (update.locationOverride !== 'none') {
    return;
  }

  await executor.query(
    `UPDATE bookings
     SET location_id = $2,
         updated_at = now()
     WHERE booking_id = $1`,
    [bookingId, update.locationId]
  );
}

export async function updateBooking(bookingId: string, input: UpdateDashboardBookingInput): Promise<DashboardBookingDetail> {
  const client = await pool.connect();
  let providerEditError: string | null = null;
  let rebuildConsumptions = false;

  try {
    await client.query("BEGIN");
    const current = await queryBookingForUpdate(client, bookingId);
    if (!current) {
      throw new DashboardNotFoundError("Booking not found.");
    }

    const currentProducts = await queryBookingProducts(client, bookingId);
    const update = await buildResolvedBookingUpdate(client, current, currentProducts, input);
    const isRegiondoBooking = current.source === 'regiondo' || Boolean(current.regiondo_booking_id);
    const hasBookingMutation = update.changedFields.some((field) => !['opsNotes', 'opsStatus'].includes(field));
    const hasLocalNoLocationOverride = update.locationOverride === 'none' && update.changedFields.includes('location');

    if (isRegiondoBooking && hasBookingMutation) {
      if (!update.providerInput && !hasLocalNoLocationOverride) {
        throw new DashboardValidationError('This Regiondo booking does not support the requested update.');
      }

      if (update.providerInput) {
        if (!current.regiondo_booking_id) {
          throw new DashboardValidationError('This Regiondo booking does not support the requested update.');
        }

        try {
          await regiondoClient.updateBooking(update.providerInput);
          const snapshot = await regiondoClient.hydrateBookingOrder({
            bookingKey: current.regiondo_booking_id,
            orderNumber: current.regiondo_order_number
          });
          const normalizedBooking = normalizeRegiondoBookingImport({
            bookingKey: current.regiondo_booking_id,
            purchaseData: snapshot.purchaseData,
            supplierBookings: snapshot.supplierBookings,
            webhookPayload: null
          });
          await upsertNormalizedRegiondoBooking(client, normalizedBooking);
        } catch (error) {
          providerEditError = getProviderEditErrorMessage(error);
          throw error;
        }
      }

      if (hasLocalNoLocationOverride) {
        await applyBookingLocationOverride(client, bookingId, update);
      }
    } else if (!isRegiondoBooking && hasBookingMutation) {
      await updateManualBooking(
        client,
        bookingId,
        current,
        update,
        update.changedFields.includes('products'),
        update.changedFields.includes('payment')
      );
    }

    await upsertBookingAdminMetadata(client, bookingId, {
      lastProviderEditError: update.clearProviderEditError ? null : current.last_provider_edit_error,
      locationOverride: update.locationOverride,
      opsNotes: update.opsNotes,
      opsStatus: update.opsStatus
    });

    rebuildConsumptions = update.rebuildConsumptions;

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original error remains visible.
    }
    if (providerEditError) {
      await recordBookingProviderEditError(bookingId, providerEditError);
    }
    throw error;
  } finally {
    client.release();
  }

  if (rebuildConsumptions) {
    await rebuildConsumptionsForBooking(bookingId);
  }

  return await getBooking(bookingId);
}
