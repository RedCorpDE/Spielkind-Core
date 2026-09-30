import { regiondoBookingProvider } from '../integrations/booking-providers/regiondo/regiondo-booking-provider.js';
import { coreBookingProvider } from '../integrations/booking-providers/core/core-booking-provider.js';
import type { BookingIntent, BookingOffering, BookingProviderType } from './booking-intent.js';

export type { BookingProviderType } from './booking-intent.js';
export type ProviderManagedBookingField = 'contact' | 'schedule' | 'attendees' | 'location' | 'products' | 'payment';

export interface ProviderAvailabilityRequest {
  externalVariantId: string;
  start: string;
  end: string;
  quantity: number;
}

export interface ProviderAvailabilitySlot {
  startsAt: string;
  available: boolean;
  remaining: number | null;
}

export interface ProviderBookingSnapshot {
  externalBookingId: string;
  orderNumber: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  quantity: number;
  totalMinor: number;
  paidMinor: number;
  currency: string;
}

export interface NormalizedAvailabilityResult {
  available: boolean;
  capacity: number | null;
  reserved: number | null;
  held: number | null;
  remaining: number | null;
  maxBookableQuantity: number | null;
  slots?: ProviderAvailabilitySlot[];
}

export interface ProviderCreateBookingInput {
  intent: BookingIntent;
  clientId: string;
  idempotencyKey: string;
  holdId?: string;
  source: 'app' | 'wordpress' | 'dashboard';
}

export interface ProviderCreateBookingResult {
  bookingId: string;
  bookingIds?: string[];
  created: boolean;
}

/** Focused integration boundary. Methods are optional when a provider does not own that operation. */
export interface BookingProvider {
  readonly key: BookingProviderType;
  readonly displayName: string;
  supportsBookingUpdates(): boolean;
  checkAvailability?(input: { intent: BookingIntent; offering: BookingOffering }): Promise<NormalizedAvailabilityResult>;
  createBooking?(input: ProviderCreateBookingInput): Promise<ProviderCreateBookingResult>;
  getAvailability?(input: ProviderAvailabilityRequest): Promise<ProviderAvailabilitySlot[]>;
  getBooking?(input: { externalBookingId: string; orderNumber?: string | null }): Promise<ProviderBookingSnapshot>;
  cancelBooking?(input: { externalBookingId: string; referenceIds: string[] }): Promise<void>;
  requestBookingChange?(input: { externalBookingId: string; changes: Record<string, unknown> }): Promise<{ accepted: boolean }>;
  isProviderManagedField(field: string): field is ProviderManagedBookingField;
  getExternalBookingUrl(input: { externalBookingId: string | null; orderNumber: string | null }): string | null;
}

const providers = new Map<BookingProviderType, BookingProvider>([
  ['core', coreBookingProvider],
  ['regiondo', regiondoBookingProvider]
]);

export const bookingProviderRegistry = {
  get(type: BookingProviderType): BookingProvider {
    const provider = providers.get(type);
    if (!provider) throw new Error(`Unsupported booking provider: ${type}`);
    return provider;
  },
  resolve(input: { bookingProvider?: string | null; source?: string | null }): BookingProvider {
    return providers.get(input.bookingProvider === 'regiondo' || input.source === 'regiondo' ? 'regiondo' : 'core') ?? coreBookingProvider;
  }
};

/** Backwards-compatible facade for existing dashboard repositories. */
export function getBookingProvider(source: string | null | undefined): BookingProvider {
  return bookingProviderRegistry.resolve({ source });
}
