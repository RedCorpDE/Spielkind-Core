import { pool } from '../../db/pool.js';
import { DashboardValidationError } from '../../dashboard/repository/core.js';
import { regiondoClient } from '../regiondo/regiondo.client.js';
import { normalizeRegiondoBookingImport } from './booking-normalizer.js';
import { importNormalizedRegiondoBooking } from './booking.repository.js';

export async function cancelBookingLocally(bookingId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE bookings
     SET status = 'canceled', updated_at = now()
     WHERE booking_id = $1`,
    [bookingId]
  );

  return Boolean(result.rowCount);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function getPurchaseRecord(rawValue: unknown): Record<string, unknown> | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  if (isRecord(rawValue.provider) && isRecord(rawValue.provider.purchaseData)) {
    return rawValue.provider.purchaseData;
  }

  if (isRecord(rawValue.purchaseData)) {
    return rawValue.purchaseData;
  }

  return null;
}

function extractReferenceIdsFromPurchaseRecord(purchaseRecord: Record<string, unknown> | null): string[] {
  if (!purchaseRecord || !Array.isArray(purchaseRecord.items)) {
    return [];
  }

  return Array.from(
    new Set(
      purchaseRecord.items.flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }

        const directReferenceId = normalizeText(item.reference_id);
        if (directReferenceId) {
          return [directReferenceId];
        }

        if (!Array.isArray(item.ticket_codes)) {
          return [];
        }

        return item.ticket_codes.flatMap((ticket) => {
          if (!isRecord(ticket)) {
            return [];
          }

          const referenceId = normalizeText(ticket.reference_id);
          return referenceId ? [referenceId] : [];
        });
      })
    )
  );
}

export async function cancelBookingInRegiondo(
  bookingId: string
): Promise<{ bookingId: string; synchronized: boolean } | null> {
  const result = await pool.query<{
    booking_id: string;
    regiondo_booking_id: string | null;
    regiondo_order_number: string | null;
    regiondo_raw: unknown;
  }>(
    `SELECT booking_id, regiondo_booking_id, regiondo_order_number, regiondo_raw
     FROM bookings
     WHERE booking_id = $1
     LIMIT 1`,
    [bookingId]
  );

  if (!result.rowCount) {
    return null;
  }

  const booking = result.rows[0];
  if (!booking.regiondo_booking_id) {
    throw new DashboardValidationError('Only Regiondo bookings can be canceled through the Regiondo API.');
  }

  let referenceIds = extractReferenceIdsFromPurchaseRecord(getPurchaseRecord(booking.regiondo_raw));

  if (!referenceIds.length) {
    const snapshot = await regiondoClient.hydrateBookingOrder({
      bookingKey: booking.regiondo_booking_id,
      orderNumber: booking.regiondo_order_number
    });
    referenceIds = extractReferenceIdsFromPurchaseRecord(snapshot.purchaseData as unknown as Record<string, unknown>);
  }

  if (!referenceIds.length) {
    throw new DashboardValidationError('No Regiondo ticket reference IDs were found for this booking.');
  }

  await regiondoClient.cancelTickets(referenceIds);

  try {
    const snapshot = await regiondoClient.hydrateBookingOrder({
      bookingKey: booking.regiondo_booking_id,
      orderNumber: booking.regiondo_order_number
    });
    const normalizedBooking = normalizeRegiondoBookingImport({
      bookingKey: booking.regiondo_booking_id,
      purchaseData: snapshot.purchaseData,
      supplierBookings: snapshot.supplierBookings,
      webhookPayload: null
    });
    await importNormalizedRegiondoBooking(normalizedBooking);

    return { bookingId: booking.booking_id, synchronized: true };
  } catch {
    await cancelBookingLocally(booking.booking_id);
    return { bookingId: booking.booking_id, synchronized: false };
  }
}
