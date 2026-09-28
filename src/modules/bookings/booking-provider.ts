import { regiondoBookingProvider } from '../integrations/booking-providers/regiondo/regiondo-booking-provider.js';

export type BookingProviderType = 'core' | 'regiondo';
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

/** Focused integration boundary. Methods are optional when a provider does not own that operation. */
export interface BookingProvider {
  readonly key: BookingProviderType;
  readonly displayName: string;
  supportsBookingUpdates(): boolean;
  getAvailability?(input: ProviderAvailabilityRequest): Promise<ProviderAvailabilitySlot[]>;
  getBooking?(input: { externalBookingId: string; orderNumber?: string | null }): Promise<ProviderBookingSnapshot>;
  cancelBooking?(input: { externalBookingId: string; referenceIds: string[] }): Promise<void>;
  requestBookingChange?(input: { externalBookingId: string; changes: Record<string, unknown> }): Promise<{ accepted: boolean }>;
  isProviderManagedField(field: string): field is ProviderManagedBookingField;
  getExternalBookingUrl(input: { externalBookingId: string | null; orderNumber: string | null }): string | null;
}

const coreProvider: BookingProvider = {
  key: 'core',
  displayName: 'Core',
  supportsBookingUpdates: () => true,
  isProviderManagedField: (_field): _field is ProviderManagedBookingField => false,
  getExternalBookingUrl: () => null
};

const providers = new Map<BookingProviderType, BookingProvider>([
  ['core', coreProvider],
  ['regiondo', regiondoBookingProvider]
]);

export const bookingProviderRegistry = {
  get(type: BookingProviderType): BookingProvider {
    const provider = providers.get(type);
    if (!provider) throw new Error(`Unsupported booking provider: ${type}`);
    return provider;
  },
  resolve(input: { bookingProvider?: string | null; source?: string | null }): BookingProvider {
    return providers.get(input.bookingProvider === 'regiondo' || input.source === 'regiondo' ? 'regiondo' : 'core') ?? coreProvider;
  }
};

/** Backwards-compatible facade for existing dashboard repositories. */
export function getBookingProvider(source: string | null | undefined): BookingProvider {
  return bookingProviderRegistry.resolve({ source });
}
