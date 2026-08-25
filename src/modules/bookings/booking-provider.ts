import { appConfig } from '../../config/env.js';

export type ProviderManagedBookingField = 'contact' | 'schedule' | 'attendees' | 'location' | 'products' | 'payment';

export interface BookingProvider {
  readonly key: string;
  readonly displayName: string;
  supportsBookingUpdates(): boolean;
  updateBooking?(input: { externalBookingId: string; changes: Record<string, unknown> }): Promise<{ accepted: boolean }>;
  isProviderManagedField(field: string): field is ProviderManagedBookingField;
  getExternalBookingUrl(input: { externalBookingId: string | null; orderNumber: string | null }): string | null;
}

const providerManagedFields = new Set<ProviderManagedBookingField>([
  'contact', 'schedule', 'attendees', 'location', 'products', 'payment'
]);

const regiondoProvider: BookingProvider = {
  key: 'regiondo',
  displayName: 'Regiondo',
  supportsBookingUpdates: () => false,
  isProviderManagedField: (field): field is ProviderManagedBookingField => providerManagedFields.has(field as ProviderManagedBookingField),
  getExternalBookingUrl: ({ externalBookingId, orderNumber }) => {
    const template = appConfig.REGIONDO_DASHBOARD_BOOKING_URL_TEMPLATE;
    if (!template || (!externalBookingId && !orderNumber)) return null;
    return template
      .replaceAll('{bookingId}', encodeURIComponent(externalBookingId ?? ''))
      .replaceAll('{orderNumber}', encodeURIComponent(orderNumber ?? ''));
  }
};

const localProvider: BookingProvider = {
  key: 'local',
  displayName: 'Local',
  supportsBookingUpdates: () => true,
  isProviderManagedField: (_field): _field is ProviderManagedBookingField => false,
  getExternalBookingUrl: () => null
};

export function getBookingProvider(source: string | null | undefined): BookingProvider {
  return source === 'regiondo' ? regiondoProvider : localProvider;
}
