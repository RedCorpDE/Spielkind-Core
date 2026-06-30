import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  DashboardBooking,
  DashboardBookingExternalStatus,
  DashboardBookingOpsStatus,
  DashboardBookingStatus,
  DashboardTask,
  DashboardTaskActivityChange,
  DashboardTaskActivityEntry,
  DashboardTaskColumn,
  DashboardTaskMutationActor,
  DashboardTaskOwner,
  DashboardTaskRawJson,
  DashboardTaskRawJsonValue,
  UpdateDashboardTaskInput
} from '../types.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';

export const DEFAULT_TASK_OWNER: DashboardTaskOwner = { id: 'unassigned', name: 'Unassigned', role: 'Operations' };
const SYSTEM_ACTIVITY_ACTOR = { name: 'System', role: 'Operations', source: 'system' } as const;
export const KNOWN_BOOKING_EXTERNAL_STATUSES = new Set<DashboardBookingExternalStatus>([
  'Pending',
  'Processing',
  'Confirmed',
  'Completed',
  'Rejected',
  'Canceled',
  'Unknown'
]);
export const KNOWN_BOOKING_OPS_STATUSES = new Set<DashboardBookingOpsStatus>(['Normal', 'Escalated']);
export const COMPLETED_TASK_PATTERN_SOURCE = 'done|completed|closed|archive';
export const COMPLETED_TASK_PATTERN = new RegExp(`(${COMPLETED_TASK_PATTERN_SOURCE})`, 'i');

export interface TaskColumnRow {
  id: string;
  title: string;
  booking_related: boolean;
  position: number;
}

export const UNASSIGNED_TASK_COLUMN: TaskColumnRow = {
  id: 'none',
  title: 'Unassigned',
  booking_related: false,
  position: -1
};

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  connected_booking_key: string | null;
  update_log: unknown;
  raw_json: unknown;
  event_date_time: Date | string | null;
  reminder_date: Date | string | null;
  reserved_capacity_date: Date | string | null;
  column_id: string | null;
  column_title: string | null;
  column_position: number | null;
  booking_related: boolean | null;
  assignee_user_id: string | null;
  owner_name: string | null;
  owner_role: string | null;
}

export interface BookingRow {
  id: string;
  status: string;
  guest_count: number;
  total_amount: string | number;
  paid_amount: string | number;
  dt_from: Date | string;
  dt_to: Date | string;
  source: string | null;
  updated_at: Date | string;
  booking_raw: unknown;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  product_title: string | null;
  regiondo_booking_id: string | null;
  regiondo_order_number: string | null;
  client_regiondo_customer_id: string | null;
  location_id: string | null;
  location_title: string | null;
  location_regiondo_location_id: string | null;
  location_override: string | null;
  last_provider_edit_error: string | null;
  ops_status: string | null;
  ops_notes: string | null;
}

export interface ExistingBookingRow {
  booking_id: string;
  dt_from: Date | string;
  dt_to: Date | string;
  ops_status: string | null;
  ops_notes: string | null;
}

export interface AssignableUserRow {
  id: string;
  display_name: string;
  role: string;
}

export type Queryable = Pick<PoolClient, 'query'>;

export class DashboardValidationError extends Error {}
export class DashboardNotFoundError extends DashboardValidationError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskRawJsonValue(value: unknown): value is DashboardTaskRawJsonValue {
  return sanitizeTaskRawJsonValue(value) !== undefined;
}

function sanitizeTaskRawJsonValue(value: unknown): DashboardTaskRawJsonValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitizedEntry = sanitizeTaskRawJsonValue(entry);
      return sanitizedEntry === undefined ? [] : [sanitizedEntry];
    });
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return Object.entries(value).reduce<Record<string, DashboardTaskRawJsonValue | undefined>>((result, [key, nestedValue]) => {
    const sanitizedValue = sanitizeTaskRawJsonValue(nestedValue);
    if (sanitizedValue !== undefined) {
      result[key] = sanitizedValue;
    }
    return result;
  }, {});
}

export function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value instanceof Date ? value : new Date(value);
  return Number.isNaN(normalized.getTime()) ? null : normalized.toISOString();
}

export function requireIsoString(value: Date | string | null | undefined, fieldName: string): string {
  const isoString = toIsoString(value);
  if (!isoString) {
    throw new DashboardValidationError(`${fieldName} is missing or invalid.`);
  }

return isoString;
}

export function toIsoStringOrThrow(value: string, fieldName: string): string {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new DashboardValidationError(`${fieldName} must be a valid date.`);
  }

  return normalized.toISOString();
}

function normalizeActor(actor?: DashboardTaskMutationActor) {
  if (!actor?.name || !actor.role) {
    return SYSTEM_ACTIVITY_ACTOR;
  }

  return { name: actor.name, role: actor.role, source: actor.source ?? 'user' } as const;
}

export function createCreatedActivityLog(actor?: DashboardTaskMutationActor, occurredAt = new Date().toISOString()) {
  return [
    {
      id: `task-activity-${randomUUID()}`,
      actor: normalizeActor(actor),
      changes: [],
      occurredAt,
      type: 'created'
    }
  ] satisfies DashboardTaskActivityEntry[];
}

function createInitialActivityLog(createdAt: string, updatedAt: string): DashboardTaskActivityEntry[] {
  const createdEntry: DashboardTaskActivityEntry = {
    id: `task-activity-${randomUUID()}`,
    actor: { name: 'External feed', role: 'Operations', source: 'external' },
    changes: [],
    metadata: { source: 'external-feed' },
    occurredAt: createdAt,
    type: 'created'
  };

  if (createdAt === updatedAt) {
    return [createdEntry];
  }

  return [
    {
      id: `task-activity-${randomUUID()}`,
      actor: { name: 'External feed', role: 'Operations', source: 'external' },
      changes: [],
      metadata: { source: 'external-feed' },
      occurredAt: updatedAt,
      type: 'synced'
    },
    createdEntry
  ];
}

function normalizeActivityLog(value: unknown, createdAt: string, updatedAt: string): DashboardTaskActivityEntry[] {
  return Array.isArray(value) ? (value as DashboardTaskActivityEntry[]) : createInitialActivityLog(createdAt, updatedAt);
}

function parseTaskRawJson(rawJson: unknown): DashboardTaskRawJson {
  const raw = isRecord(rawJson) ? rawJson : {};
  const normalized = Object.entries(raw).reduce<DashboardTaskRawJson>((result, [key, value]) => {
    const sanitizedValue = sanitizeTaskRawJsonValue(value);
    if (sanitizedValue === undefined) {
      return result;
    }

    result[key] = sanitizedValue;
    return result;
  }, {});

  if (typeof normalized.site !== 'string') {
    normalized.site = '';
  }

  return normalized;
}

function mapTaskColumnFromTaskRow(row: TaskRow): TaskColumnRow {
  if (!row.column_id) {
    return { ...UNASSIGNED_TASK_COLUMN };
  }

  return {
    id: row.column_id,
    title: row.column_title ?? UNASSIGNED_TASK_COLUMN.title,
    booking_related: row.booking_related ?? false,
    position: row.column_position ?? UNASSIGNED_TASK_COLUMN.position
  };
}

export function mapTaskRow(row: TaskRow): DashboardTask {
  const createdAt = requireIsoString(row.created_at, 'tasks.created_at');
  const updatedAt = requireIsoString(row.updated_at, 'tasks.updated_at');
  const raw = parseTaskRawJson(row.raw_json);
  const column = mapTaskColumnFromTaskRow(row);

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: column.title,
    eventDateTime: toIsoString(row.event_date_time),
    reminderDate: toIsoString(row.reminder_date),
    reservedCapacityDate: toIsoString(row.reserved_capacity_date),
    owner: row.assignee_user_id
      ? {
          id: row.assignee_user_id,
          name: row.owner_name ?? DEFAULT_TASK_OWNER.name,
          role: row.owner_role ?? DEFAULT_TASK_OWNER.role
        }
      : { ...DEFAULT_TASK_OWNER },
    rawJson: raw,
    site: typeof raw.site === 'string' ? raw.site : '',
    createdAt,
    updatedAt,
    activityLog: normalizeActivityLog(row.update_log, createdAt, updatedAt),
    columnId: column.id,
    columnTitle: column.title,
    columnPosition: column.position,
    bookingRelated: column.booking_related,
    connectedBookingId: row.connected_booking_key
  };
}

export function mapTaskColumnRow(row: TaskColumnRow): DashboardTaskColumn {
  return { id: row.id, title: row.title, bookingRelated: row.booking_related, position: row.position };
}

function mapDbBookingStatus(status: string): DashboardBookingExternalStatus {
  switch (status) {
    case 'processing':
      return 'Processing';
    case 'confirmed':
      return 'Confirmed';
    case 'completed':
      return 'Completed';
    case 'rejected':
      return 'Rejected';
    case 'canceled':
      return 'Canceled';
    case 'unknown':
      return 'Unknown';
    default:
      return 'Pending';
  }
}

export function mapDashboardExternalStatusToDb(status: DashboardBookingExternalStatus): string {
  switch (status) {
    case 'Processing':
      return 'processing';
    case 'Confirmed':
      return 'confirmed';
    case 'Completed':
      return 'completed';
    case 'Rejected':
      return 'rejected';
    case 'Canceled':
      return 'canceled';
    case 'Unknown':
      return 'unknown';
    default:
      return 'pending';
  }
}

function getProviderRawSection(rawValue: unknown): Record<string, unknown> | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  const provider = rawValue.provider;
  if (isRecord(provider)) {
    return provider;
  }

  return rawValue;
}

function getPurchaseDataRaw(rawValue: unknown): Record<string, unknown> | null {
  const provider = getProviderRawSection(rawValue);
  if (!provider) {
    return null;
  }

  const purchaseData = provider.purchaseData;
  return isRecord(purchaseData) ? purchaseData : null;
}

function getManualRawSection(rawValue: unknown): Record<string, unknown> | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  const manual = rawValue.manual;
  return isRecord(manual) ? manual : null;
}

function getFirstSupplierBookingRaw(rawValue: unknown): Record<string, unknown> | null {
  const provider = getProviderRawSection(rawValue);
  if (!provider) {
    return null;
  }

  const supplierBookings = provider.supplierBookings;
  if (!Array.isArray(supplierBookings) || !supplierBookings.length) {
    return null;
  }

  return isRecord(supplierBookings[0]) ? (supplierBookings[0] as Record<string, unknown>) : null;
}

function extractPurchaseContactField(rawValue: unknown, field: 'email' | 'firstname' | 'lastname'): string | null {
  const manual = getManualRawSection(rawValue);
  if (manual) {
    const contact = manual.contact;
    if (isRecord(contact)) {
      const manualField =
        field === 'firstname' ? 'firstName' : field === 'lastname' ? 'lastName' : 'email';
      const manualValue = contact[manualField];
      if (typeof manualValue === 'string' && manualValue.trim()) {
        return manualValue.trim();
      }
    }
  }

  const purchaseData = getPurchaseDataRaw(rawValue);
  if (!purchaseData) {
    return null;
  }

  const contactData = purchaseData.contact_data;
  if (!isRecord(contactData)) {
    return null;
  }

  const value = contactData[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractBookingProductTitle(rawValue: unknown): string | null {
  const manual = getManualRawSection(rawValue);
  if (manual && Array.isArray(manual.regiondoSelections)) {
    for (const selection of manual.regiondoSelections) {
      if (!isRecord(selection)) {
        continue;
      }

      const productTitle = selection.productTitle;
      if (typeof productTitle === 'string' && productTitle.trim()) {
        return productTitle.trim();
      }
    }
  }

  const purchaseData = getPurchaseDataRaw(rawValue);
  if (purchaseData) {
    const items = purchaseData.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!isRecord(item)) {
          continue;
        }

        const ticketName = item.ticket_name;
        if (typeof ticketName === 'string' && ticketName.trim()) {
          return ticketName.trim();
        }

        const productName = item.product_name;
        if (typeof productName === 'string' && productName.trim()) {
          return productName.trim();
        }
      }
    }
  }

  const supplierBooking = getFirstSupplierBookingRaw(rawValue);
  if (!supplierBooking) {
    return null;
  }

  const productName = supplierBooking.product_name;
  if (typeof productName === 'string' && productName.trim()) {
    return productName.trim();
  }

  const ticketName = supplierBooking.ticket_name;
  return typeof ticketName === 'string' && ticketName.trim() ? ticketName.trim() : null;
}

function extractBookingSource(rawValue: unknown): string {
  if (isRecord(rawValue) && typeof rawValue.source === 'string') {
    switch (rawValue.source.trim()) {
      case 'manual_task':
        return 'Manual task';
      case 'manual':
        return 'Manual';
      default:
        return rawValue.source.trim();
    }
  }

  const purchaseData = getPurchaseDataRaw(rawValue);
  if (purchaseData) {
    const salesChannel = purchaseData.sales_channel;
    if (typeof salesChannel === 'string' && salesChannel.trim()) {
      return salesChannel.trim();
    }
  }

  return 'Regiondo';
}

function extractBookingNotes(rawValue: unknown): string {
  if (!isRecord(rawValue)) {
    return '';
  }

  if (typeof rawValue.notes === 'string') {
    return rawValue.notes;
  }

  const purchaseData = getPurchaseDataRaw(rawValue);
  if (!purchaseData) {
    return '';
  }

  const buyerData = purchaseData.buyer_data;
  if (!Array.isArray(buyerData)) {
    return '';
  }

  const notes = buyerData
    .filter(isRecord)
    .map((field) => {
      const title = typeof field.title === 'string' ? field.title : '';
      const value = typeof field.value === 'string' ? field.value : typeof field.value === 'number' ? `${field.value}` : '';

      return /note|message|special|requirement/i.test(title) ? value.trim() : '';
    })
    .filter(Boolean);

  return notes.join('\n');
}

function mapDbOpsStatus(status: string | null | undefined): DashboardBookingOpsStatus {
  return status === 'escalated' ? 'Escalated' : 'Normal';
}

function isPlaceholderProviderId(value: string | null | undefined, placeholderId: string): boolean {
  return value === placeholderId;
}

export function mapBookingRow(row: BookingRow): DashboardBooking {
  const externalStatus = mapDbBookingStatus(row.status);
  const opsStatus = mapDbOpsStatus(row.ops_status);
  const status: DashboardBookingStatus = opsStatus === 'Escalated' ? 'Escalated' : externalStatus;
  const customerDataStatus = isPlaceholderProviderId(
    row.client_regiondo_customer_id,
    SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID
  )
    ? 'unknown'
    : 'known';
  const locationDataStatus =
    row.location_override === 'none' ||
    isPlaceholderProviderId(row.location_regiondo_location_id, SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID)
      ? 'none'
      : isPlaceholderProviderId(row.location_regiondo_location_id, SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID)
        ? 'unknown'
        : 'known';

  return {
    id: row.id,
    familyName:
      extractPurchaseContactField(row.booking_raw, 'lastname') ??
      row.last_name ??
      (customerDataStatus === 'unknown' ? 'Unknown customer' : 'Unknown'),
    childName:
      extractPurchaseContactField(row.booking_raw, 'firstname') ??
      row.first_name ??
      (customerDataStatus === 'unknown' ? 'Unknown child' : 'Unknown'),
    customerDataStatus,
    experience: row.product_title ?? extractBookingProductTitle(row.booking_raw) ?? 'Booking',
    bookingDate: requireIsoString(row.dt_from, 'bookings.dt_from'),
    bookingEndDate: requireIsoString(row.dt_to, 'bookings.dt_to'),
    status,
    externalStatus,
    opsStatus,
    contactEmail: extractPurchaseContactField(row.booking_raw, 'email') ?? row.email ?? '',
    attendees: Math.max(1, row.guest_count),
    source: extractBookingSource(row.booking_raw),
    specialRequirements: extractBookingNotes(row.booking_raw),
    depositPaid: Number(row.paid_amount) > 0 || Number(row.paid_amount) >= Number(row.total_amount),
    opsNotes: row.ops_notes ?? '',
    locationId: locationDataStatus === 'known' ? row.location_id : null,
    locationTitle:
      locationDataStatus === 'none'
        ? 'No location'
        : locationDataStatus === 'unknown'
          ? 'Unknown Regiondo location'
          : row.location_title ?? 'Unknown Location',
    locationDataStatus,
    regiondoBookingId: row.regiondo_booking_id,
    regiondoOrderNumber: row.regiondo_order_number,
    lastUpdated: requireIsoString(row.updated_at, 'bookings.updated_at'),
    updateCapabilities: {
      attendees: true,
      contact: true,
      location: true,
      opsMetadata: true,
      payment: true,
      products: true,
      schedule: true
    }
  };
}

function normalizeComparableValue(value: string | number | boolean | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : undefined;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return `${value}`;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? normalized : undefined;
  }

  return undefined;
}

function createActivityChange(
  field: string,
  from: string | number | boolean | string[] | null | undefined,
  to: string | number | boolean | string[] | null | undefined
): DashboardTaskActivityChange | null {
  const normalizedFrom = normalizeComparableValue(from);
  const normalizedTo = normalizeComparableValue(to);
  return normalizedFrom === normalizedTo ? null : { field, from: normalizedFrom, to: normalizedTo };
}

function isDatabaseError(error: unknown): error is { code?: string; constraint?: string } {
  return isRecord(error);
}

export function throwTaskColumnMutationError(error: unknown): never {
  if (isDatabaseError(error)) {
    if (error.code === '23505') {
      if (typeof error.constraint === 'string' && error.constraint.includes('title')) {
        throw new DashboardValidationError('A task column with this title already exists.');
      }

      throw new DashboardValidationError('Task column order could not be saved. Try again.');
    }

    if (error.code === '23503') {
      throw new DashboardValidationError(
        'Task column changes could not be applied because related tasks were not reassigned.'
      );
    }
  }

  throw error;
}

export function isUnassignedTaskColumnId(columnId: string | null | undefined): boolean {
  return columnId === null || columnId === UNASSIGNED_TASK_COLUMN.id;
}

export function toStoredTaskColumnId(column: TaskColumnRow): string | null {
  return column.id === UNASSIGNED_TASK_COLUMN.id ? null : column.id;
}

export function resolveTaskColumnInsertPosition(position: number | undefined, columnCount: number): number {
  if (typeof position !== 'number') {
    return columnCount;
  }

  if (position < 0 || position > columnCount) {
    throw new DashboardValidationError(`position must be between 0 and ${columnCount}.`);
  }

  return position;
}

export function resolveTaskColumnUpdatePosition(
  position: number | undefined,
  columnCount: number,
  currentPosition: number
): number {
  if (typeof position !== 'number') {
    return currentPosition;
  }

  const maxPosition = Math.max(0, columnCount - 1);
  if (position < 0 || position > maxPosition) {
    throw new DashboardValidationError(`position must be between 0 and ${maxPosition}.`);
  }

  return position;
}

export function resolveTaskColumnReorderOrder(
  orderedColumnIds: string[],
  existingColumns: TaskColumnRow[]
): string[] {
  if (orderedColumnIds.length !== existingColumns.length) {
    throw new DashboardValidationError('orderedColumnIds must include every task column exactly once.');
  }

  const existingColumnIds = new Set(existingColumns.map((column) => column.id));
  const seenColumnIds = new Set<string>();

  for (const columnId of orderedColumnIds) {
    if (!existingColumnIds.has(columnId) || seenColumnIds.has(columnId)) {
      throw new DashboardValidationError('orderedColumnIds must include every task column exactly once.');
    }

    seenColumnIds.add(columnId);
  }

  return orderedColumnIds;
}

export function appendTaskUpdateActivity(
  existingTask: DashboardTask,
  input: UpdateDashboardTaskInput,
  actor: DashboardTaskMutationActor | undefined,
  column: TaskColumnRow,
  owner: DashboardTaskOwner | null
): DashboardTaskActivityEntry[] {
  const changes = [
    createActivityChange('title', existingTask.title, input.title.trim()),
    createActivityChange('description', existingTask.description, input.description.trim()),
    createActivityChange('eventDateTime', existingTask.eventDateTime, input.eventDateTime),
    createActivityChange('reminderDate', existingTask.reminderDate, input.reminderDate ?? null),
    createActivityChange('reservedCapacityDate', existingTask.reservedCapacityDate, input.reservedCapacityDate ?? null),
    createActivityChange('owner', existingTask.owner.name, owner?.name ?? DEFAULT_TASK_OWNER.name),
    createActivityChange('site', existingTask.site, input.site.trim()),
    createActivityChange('status', existingTask.columnTitle, column.title),
    createActivityChange('connectedBookingId', existingTask.connectedBookingId, input.connectedBookingId ?? null)
  ].filter((change): change is DashboardTaskActivityChange => Boolean(change));

  if (!changes.length) {
    return existingTask.activityLog;
  }

  return [
    {
      id: `task-activity-${randomUUID()}`,
      actor: normalizeActor(actor),
      changes,
      occurredAt: new Date().toISOString(),
      type: 'updated'
    },
    ...existingTask.activityLog
  ];
}
