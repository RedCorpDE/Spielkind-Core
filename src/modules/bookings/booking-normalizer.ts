import { aggregateRegiondoBookingStatus, type BookingStatus } from './booking-status.mapper.js';
import { RegiondoPayloadError } from '../regiondo/regiondo.client.js';
import { parseRegiondoDateTime } from '../regiondo/regiondo-datetime.js';
import type {
  LegacyRegiondoBooking,
  RegiondoPurchaseData,
  RegiondoSoldItem,
  RegiondoSupplierBooking,
  RegiondoWebhookPayload
} from '../regiondo/regiondo.types.js';

const durationUnitToMs: Record<string, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  night: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};

function createNormalizationError(details: string): RegiondoPayloadError {
  return new RegiondoPayloadError('Regiondo booking snapshot could not be normalized.', details);
}

export interface NormalizedRegiondoBookingImport {
  bookingKey: string;
  orderNumber: string;
  status: BookingStatus;
  snapshotGeneratedAt: string;
  dtFrom: string;
  dtTo: string;
  guestCount: number;
  totalAmount: number;
  paidAmount: number;
  client: {
    regiondoCustomerId: string | null;
    firstName: string;
    lastName: string;
    email: string | null;
    phoneNumber: string | null;
    raw: unknown;
  };
  location: {
    regiondoLocationId: string | null;
    title: string | null;
    raw: unknown;
  };
  items: Array<{
    regiondoProductId: string;
    title: string;
    quantity: number;
    unitPrice: number;
    raw: unknown;
  }>;
  payments: Array<{
    amount: number;
    type: 'cash' | 'card' | 'paypal' | 'sepa' | 'bank_transfer' | 'voucher' | 'other';
    providerRef: string | null;
  }>;
  raw: unknown;
}

function stringifyRegiondoId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function isLegacyPayload(payload: RegiondoWebhookPayload | null | undefined): payload is LegacyRegiondoBooking {
  return Boolean(payload && 'id' in payload && !('full_purchase_data' in payload));
}

function normalizeNamePart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function deriveContactDetails(input: {
  purchaseData: RegiondoPurchaseData;
  supplierBookings: RegiondoSupplierBooking[];
  webhookPayload?: RegiondoWebhookPayload | null;
}) {
  const purchaseContact = input.purchaseData.contact_data;
  const fallbackBooking = input.supplierBookings[0];
  const bookingContact = fallbackBooking?.contact_data;
  const legacyPayload = isLegacyPayload(input.webhookPayload) ? input.webhookPayload : null;

  return {
    regiondoCustomerId: stringifyRegiondoId(legacyPayload?.customer?.id),
    firstName: normalizeNamePart(
      purchaseContact?.firstname ?? bookingContact?.firstname ?? fallbackBooking?.first_name ?? legacyPayload?.customer?.first_name,
      'Unknown'
    ),
    lastName: normalizeNamePart(
      purchaseContact?.lastname ?? bookingContact?.lastname ?? fallbackBooking?.last_name ?? legacyPayload?.customer?.last_name,
      'Unknown'
    ),
    email:
      purchaseContact?.email?.trim() ??
      bookingContact?.email?.trim() ??
      fallbackBooking?.email?.trim() ??
      legacyPayload?.customer?.email?.trim() ??
      null,
    phoneNumber:
      purchaseContact?.telephone?.trim() ??
      bookingContact?.telephone?.trim() ??
      fallbackBooking?.phone_number?.trim() ??
      legacyPayload?.customer?.phone_number?.trim() ??
      null
  };
}

function deriveLocationHint(webhookPayload?: RegiondoWebhookPayload | null) {
  const legacyPayload = isLegacyPayload(webhookPayload) ? webhookPayload : null;
  return {
    regiondoLocationId: stringifyRegiondoId(legacyPayload?.location?.id),
    title: legacyPayload?.location?.title?.trim() ?? legacyPayload?.location?.name?.trim() ?? null
  };
}

function selectPurchaseItemsForBooking(purchaseData: RegiondoPurchaseData, bookingKey: string): RegiondoSoldItem[] {
  return purchaseData.items.filter((item) => item.booking_key === bookingKey);
}

function calculateBookingRange(input: {
  supplierBookings: RegiondoSupplierBooking[];
  purchaseTimestamp?: string | undefined;
}): { dtFrom: string; dtTo: string } {
  const starts = input.supplierBookings
    .map((booking) => booking.event_date_time ?? booking.date_applied_for)
    .filter((value): value is string => Boolean(value))
    .map((value) => parseRegiondoDateTime(value))
    .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  const fallbackStart = parseRegiondoDateTime(input.purchaseTimestamp);
  const startDate = starts[0] ?? (fallbackStart && !Number.isNaN(fallbackStart.getTime()) ? fallbackStart : null);

  if (!startDate) {
    throw createNormalizationError('Regiondo booking snapshot does not include a usable start timestamp.');
  }

  const computedEnds = input.supplierBookings
    .map((booking) => {
      const startValue = booking.event_date_time ?? booking.date_applied_for;
      const start = parseRegiondoDateTime(startValue);
      const unit = booking.duration_type?.trim().toLowerCase() ?? '';
      const multiplier = durationUnitToMs[unit];
      const duration = typeof booking.duration_value === 'number' ? booking.duration_value : null;

      if (!start || Number.isNaN(start.getTime()) || !multiplier || !duration || duration <= 0) {
        return null;
      }

      return new Date(start.getTime() + multiplier * duration);
    })
    .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());

  const endDate = computedEnds[0] ?? new Date(startDate.getTime() + 60 * 60 * 1000);
  return {
    dtFrom: startDate.toISOString(),
    dtTo: endDate.toISOString()
  };
}

function mapPaymentType(value: string | null | undefined): 'cash' | 'card' | 'paypal' | 'sepa' | 'bank_transfer' | 'voucher' | 'other' {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'cash':
      return 'cash';
    case 'card':
    case 'credit_card':
      return 'card';
    case 'paypal':
      return 'paypal';
    case 'sepa':
      return 'sepa';
    case 'bank_transfer':
    case 'banktransfer':
      return 'bank_transfer';
    case 'voucher':
      return 'voucher';
    default:
      return 'other';
  }
}

export function normalizeRegiondoBookingImport(input: {
  bookingKey: string;
  purchaseData: RegiondoPurchaseData;
  supplierBookings: RegiondoSupplierBooking[];
  webhookPayload?: RegiondoWebhookPayload | null;
}): NormalizedRegiondoBookingImport {
  const matchingSupplierBookings = input.supplierBookings.filter((booking) => booking.booking_key === input.bookingKey);
  if (!matchingSupplierBookings.length) {
    throw createNormalizationError(`Supplier booking snapshot does not contain booking key ${input.bookingKey}.`);
  }

  const matchingItems = selectPurchaseItemsForBooking(input.purchaseData, input.bookingKey);
  if (!matchingItems.length) {
    throw createNormalizationError(`Purchase snapshot does not contain booking key ${input.bookingKey}.`);
  }

  const snapshotGeneratedAt = new Date(input.purchaseData.info_generated_at);
  if (Number.isNaN(snapshotGeneratedAt.getTime())) {
    throw createNormalizationError('Regiondo purchase snapshot does not include a valid info_generated_at timestamp.');
  }

  const bookingRange = calculateBookingRange({
    supplierBookings: matchingSupplierBookings,
    purchaseTimestamp: input.purchaseData.purchased_at
  });

  const contact = deriveContactDetails(input);
  const location = deriveLocationHint(input.webhookPayload);
  const status = aggregateRegiondoBookingStatus(matchingSupplierBookings);

  const totals = matchingItems.reduce(
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

  const items = matchingItems
    .map((item) => {
      const regiondoProductId = stringifyRegiondoId(item.product_id);
      if (!regiondoProductId) {
        return null;
      }

      return {
        regiondoProductId,
        title: item.ticket_name?.trim() || item.product_name?.trim() || 'Imported Product',
        quantity: Math.max(1, item.ticket_qty ?? 1),
        unitPrice:
          typeof item.price_per_one_incl_tax === 'number' && Number.isFinite(item.price_per_one_incl_tax)
            ? item.price_per_one_incl_tax
            : 0,
        raw: item
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (!items.length) {
    throw createNormalizationError(`No Regiondo product identifiers were present for booking ${input.bookingKey}.`);
  }

  const orderNumber = stringifyRegiondoId(input.purchaseData.order_number);
  if (!orderNumber) {
    throw createNormalizationError(`Regiondo purchase snapshot does not expose an order number for booking ${input.bookingKey}.`);
  }

  const paidAmount = totals.paidAmount > 0 ? totals.paidAmount : 0;
  const payments =
    paidAmount > 0
      ? [
          {
            amount: paidAmount,
            type: mapPaymentType(input.purchaseData.payment_method ?? input.purchaseData.sales_channel),
            providerRef: orderNumber
          }
        ]
      : [];

  return {
    bookingKey: input.bookingKey,
    orderNumber,
    status,
    snapshotGeneratedAt: snapshotGeneratedAt.toISOString(),
    dtFrom: bookingRange.dtFrom,
    dtTo: bookingRange.dtTo,
    guestCount: Math.max(1, totals.guestCount || matchingSupplierBookings.reduce((sum, booking) => sum + (booking.qty ?? 0), 0)),
    totalAmount: totals.totalAmount,
    paidAmount,
    client: {
      ...contact,
      raw: {
        source: 'regiondo',
        purchaseContact: input.purchaseData.contact_data ?? null,
        supplierBookings: matchingSupplierBookings
      }
    },
    location: {
      ...location,
      raw: {
        source: 'regiondo',
        hint: location
      }
    },
    items,
    payments,
    raw: {
      purchaseData: input.purchaseData,
      supplierBookings: matchingSupplierBookings,
      webhookPayload: input.webhookPayload ?? null
    }
  };
}
