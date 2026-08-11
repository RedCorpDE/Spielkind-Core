import type { RegiondoSupplierBooking } from './regiondo.types.js';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface RegiondoBookingSyncWindow {
  cursorValue: string;
  endDate: string;
  startDate: string;
}

export interface RegiondoBookingSyncCandidate {
  bookingKey: string;
  orderNumber: string | null;
}

export interface RegiondoBookingSyncCliOptions {
  bookingKey?: string;
  full: boolean;
}

export function parseRegiondoBookingSyncCliArgs(args: string[]): RegiondoBookingSyncCliOptions {
  let bookingKey: string | undefined;
  let full = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--full') {
      full = true;
      continue;
    }

    if (argument === '--booking-key') {
      bookingKey = args[index + 1]?.trim();
      index += 1;
    } else if (argument.startsWith('--booking-key=')) {
      bookingKey = argument.slice('--booking-key='.length).trim();
    } else {
      throw new Error(`Unknown Regiondo booking sync option: ${argument}`);
    }

    if (!bookingKey) {
      throw new Error('--booking-key requires a non-empty Regiondo booking key.');
    }
  }

  if (full && bookingKey) {
    throw new Error('Use either --full or --booking-key, not both.');
  }

  return { ...(bookingKey ? { bookingKey } : {}), full };
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function stringifyRegiondoId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function buildRegiondoBookingSyncWindow(input: {
  initialLookbackDays: number;
  lastSuccessAt?: string | null;
  now?: Date;
  overlapDays: number;
}): RegiondoBookingSyncWindow {
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('Regiondo booking sync requires a valid current timestamp.');
  }

  const fallbackAnchor = new Date(now.getTime() - input.initialLookbackDays * DAY_IN_MS);
  const lastSuccessAt = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const anchor =
    lastSuccessAt && !Number.isNaN(lastSuccessAt.getTime())
      ? lastSuccessAt
      : fallbackAnchor;
  const start = new Date(anchor.getTime() - input.overlapDays * DAY_IN_MS);

  return {
    cursorValue: now.toISOString(),
    endDate: toDateOnly(now),
    startDate: toDateOnly(start)
  };
}

export function collectRegiondoBookingSyncCandidates(
  bookings: RegiondoSupplierBooking[]
): RegiondoBookingSyncCandidate[] {
  const candidatesByBookingKey = new Map<string, RegiondoBookingSyncCandidate>();

  for (const booking of bookings) {
    const bookingKey = booking.booking_key?.trim();
    if (!bookingKey) {
      continue;
    }

    const orderNumber = stringifyRegiondoId(booking.order_number);
    const existing = candidatesByBookingKey.get(bookingKey);

    if (!existing) {
      candidatesByBookingKey.set(bookingKey, { bookingKey, orderNumber });
      continue;
    }

    if (!existing.orderNumber && orderNumber) {
      existing.orderNumber = orderNumber;
    }
  }

  return Array.from(candidatesByBookingKey.values()).sort((left, right) =>
    left.bookingKey.localeCompare(right.bookingKey)
  );
}
