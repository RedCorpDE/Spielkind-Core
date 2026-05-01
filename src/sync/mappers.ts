import type {
  LegacyRegiondoBooking,
  RegiondoPurchaseDataPush,
  RegiondoSupplierBooking,
  RegiondoWebhookPayload
} from './types.js';

export const SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID = '__unknown_regiondo_customer__';
export const SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID = '__unknown_regiondo_location__';

const durationUnitToMs: Record<string, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  night: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};

const pendingStatuses = new Set(['created', 'pending', 'sent', 'booked', 'reserved', 'waiting_confirmation', 'action_required']);
const confirmedStatuses = new Set(['approved', 'confirmed', 'checked_in']);
const completedStatuses = new Set(['completed']);
const rejectedStatuses = new Set(['rejected']);
const canceledStatuses = new Set(['canceled', 'cancelled', 'no_show']);

export function stringifyRegiondoId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function normalizeStoredBookingStatus(status: string | undefined): string {
  const normalized = status?.trim().toLowerCase();

  if (!normalized) {
    return 'pending';
  }

  if (pendingStatuses.has(normalized)) {
    return 'pending';
  }

  if (normalized === 'processing') {
    return 'processing';
  }

  if (confirmedStatuses.has(normalized)) {
    return 'confirmed';
  }

  if (completedStatuses.has(normalized)) {
    return 'completed';
  }

  if (rejectedStatuses.has(normalized)) {
    return 'rejected';
  }

  if (canceledStatuses.has(normalized)) {
    return 'canceled';
  }

  return 'unknown';
}

export function isPurchaseDataPushPayload(payload: RegiondoWebhookPayload): payload is RegiondoPurchaseDataPush {
  return 'full_purchase_data' in payload;
}

export function isLegacyBookingPayload(payload: RegiondoWebhookPayload): payload is LegacyRegiondoBooking {
  return 'id' in payload && !('full_purchase_data' in payload);
}

export function extractBookingKeysFromWebhook(payload: RegiondoWebhookPayload): string[] {
  if (isPurchaseDataPushPayload(payload)) {
    return Array.from(new Set(payload.full_purchase_data.items.map((item) => item.booking_key).filter(Boolean)));
  }

  const legacyId = stringifyRegiondoId(payload.id);
  return legacyId ? [legacyId] : [];
}

export function extractWebhookOrderNumber(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return stringifyRegiondoId(payload.full_purchase_data.order_number);
  }

  return null;
}

export function extractWebhookSnapshotAt(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.full_purchase_data.info_generated_at;
  }

  return null;
}

export function extractWebhookActionType(payload: RegiondoWebhookPayload): string {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.action_type;
  }

  return 'legacy_booking_event';
}

export function extractWebhookChannel(payload: RegiondoWebhookPayload): string {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.channel;
  }

  return 'unknown';
}

export function extractLegacyCustomerId(payload: RegiondoWebhookPayload): string | null {
  if (!isLegacyBookingPayload(payload)) {
    return null;
  }

  return stringifyRegiondoId(payload.customer?.id);
}

export function extractLegacyLocation(payload: RegiondoWebhookPayload): { regiondoLocationId: string | null; title: string | null } {
  if (!isLegacyBookingPayload(payload)) {
    return { regiondoLocationId: null, title: null };
  }

  return {
    regiondoLocationId: stringifyRegiondoId(payload.location?.id),
    title: payload.location?.title?.trim() || payload.location?.name?.trim() || null
  };
}

export function calculateBookingRange(input: {
  supplierBookings: RegiondoSupplierBooking[];
  purchaseTimestamp?: string | undefined;
  existingDurationMs?: number | null;
}): { dtFrom: string; dtTo: string } {
  const starts = input.supplierBookings
    .map((booking) => booking.event_date_time ?? booking.date_applied_for)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  const fallbackStart = input.purchaseTimestamp ? new Date(input.purchaseTimestamp) : null;
  const startDate =
    starts[0] ??
    (fallbackStart && !Number.isNaN(fallbackStart.getTime()) ? fallbackStart : null);

  if (!startDate) {
    throw new Error('Regiondo booking snapshot does not include a usable event or purchase date.');
  }

  const computedEnds = input.supplierBookings
    .map((booking) => {
      const startValue = booking.event_date_time ?? booking.date_applied_for;
      const start = startValue ? new Date(startValue) : null;
      const unit = booking.duration_type?.trim().toLowerCase() ?? '';
      const multiplier = durationUnitToMs[unit];
      const value = typeof booking.duration_value === 'number' && Number.isFinite(booking.duration_value) ? booking.duration_value : null;

      if (!start || Number.isNaN(start.getTime()) || !multiplier || !value || value <= 0) {
        return null;
      }

      return new Date(start.getTime() + multiplier * value);
    })
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime());

  const durationFallbackMs =
    input.existingDurationMs && input.existingDurationMs > 0 ? input.existingDurationMs : 60 * 60 * 1000;
  const endDate = computedEnds[0] ?? new Date(startDate.getTime() + durationFallbackMs);

  return {
    dtFrom: startDate.toISOString(),
    dtTo: endDate.toISOString()
  };
}

export function aggregateBookingStatus(supplierBookings: RegiondoSupplierBooking[]): string {
  const statuses = supplierBookings.map((booking) => normalizeStoredBookingStatus(booking.status));

  if (statuses.some((status) => status === 'processing')) {
    return 'processing';
  }

  if (statuses.some((status) => status === 'pending')) {
    return 'pending';
  }

  if (statuses.length > 0 && statuses.every((status) => status === 'canceled')) {
    return 'canceled';
  }

  if (statuses.length > 0 && statuses.every((status) => status === 'rejected')) {
    return 'rejected';
  }

  if (statuses.length > 0 && statuses.every((status) => status === 'completed')) {
    return 'completed';
  }

  if (statuses.some((status) => status === 'confirmed' || status === 'completed')) {
    return 'confirmed';
  }

  return statuses[0] ?? 'unknown';
}
