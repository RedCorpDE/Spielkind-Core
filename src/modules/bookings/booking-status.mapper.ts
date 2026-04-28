import type { RegiondoSupplierBooking } from '../regiondo/regiondo.types.js';

export type BookingStatus =
  | 'draft'
  | 'pending'
  | 'processing'
  | 'confirmed'
  | 'completed'
  | 'rejected'
  | 'canceled'
  | 'unknown';

const pendingStatuses = new Set(['created', 'pending', 'sent', 'booked', 'reserved', 'waiting_confirmation', 'action_required']);
const confirmedStatuses = new Set(['approved', 'confirmed', 'checked_in']);
const completedStatuses = new Set(['completed']);
const rejectedStatuses = new Set(['rejected']);
const canceledStatuses = new Set(['canceled', 'cancelled', 'full cancellation', 'full_cancelation', 'no_show']);

export function mapRegiondoBookingStatus(input: {
  status?: string | null;
  quantity?: number | null;
  quantityCancelled?: number | null;
}): BookingStatus {
  const normalized = input.status?.trim().toLowerCase();

  if (input.quantity && input.quantityCancelled && input.quantityCancelled >= input.quantity) {
    return 'canceled';
  }

  if (!normalized) {
    return 'unknown';
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

export function aggregateRegiondoBookingStatus(bookings: RegiondoSupplierBooking[]): BookingStatus {
  const statuses = bookings.map((booking) =>
    mapRegiondoBookingStatus({
      status: booking.status,
      quantity: booking.qty,
      quantityCancelled: booking.qty_cancelled
    })
  );

  if (statuses.some((status) => status === 'processing')) {
    return 'processing';
  }

  if (statuses.every((status) => status === 'canceled')) {
    return 'canceled';
  }

  if (statuses.every((status) => status === 'rejected')) {
    return 'rejected';
  }

  if (statuses.every((status) => status === 'completed')) {
    return 'completed';
  }

  if (statuses.some((status) => status === 'confirmed' || status === 'completed')) {
    return 'confirmed';
  }

  if (statuses.some((status) => status === 'pending')) {
    return 'pending';
  }

  return statuses[0] ?? 'unknown';
}
