import type { BookingProvider, ProviderManagedBookingField } from '../../../bookings/booking-provider.js';
import { appConfig } from '../../../../config/env.js';
import { normalizeRegiondoBookingImport } from '../../../bookings/booking-normalizer.js';
import { extractRegiondoAvailabilitySlots } from '../../../regiondo/regiondo-catalog-normalizer.js';
import { regiondoClient } from '../../../regiondo/regiondo.client.js';

const managedFields = new Set<ProviderManagedBookingField>([
  'contact', 'schedule', 'attendees', 'location', 'products', 'payment'
]);

export const regiondoBookingProvider: BookingProvider = {
  key: 'regiondo',
  displayName: 'Regiondo',
  supportsBookingUpdates: () => false,
  isProviderManagedField: (field): field is ProviderManagedBookingField => managedFields.has(field as ProviderManagedBookingField),
  getExternalBookingUrl: ({ externalBookingId, orderNumber }) => {
    const template = appConfig.REGIONDO_DASHBOARD_BOOKING_URL_TEMPLATE;
    if (!template || (!externalBookingId && !orderNumber)) return null;
    return template
      .replaceAll('{bookingId}', encodeURIComponent(externalBookingId ?? ''))
      .replaceAll('{orderNumber}', encodeURIComponent(orderNumber ?? ''));
  },
  async getAvailability(input) {
    const raw = await regiondoClient.getVariationAvailability({
      variationId: input.externalVariantId,
      from: input.start,
      to: input.end
    });
    return extractRegiondoAvailabilitySlots(raw, 500).map((slot) => ({
      startsAt: `${slot.date}T${slot.time}:00`,
      available: true,
      remaining: null
    }));
  },
  async getBooking(input) {
    const snapshot = await regiondoClient.hydrateBookingOrder({
      bookingKey: input.externalBookingId,
      orderNumber: input.orderNumber
    });
    const normalized = normalizeRegiondoBookingImport({
      bookingKey: input.externalBookingId,
      purchaseData: snapshot.purchaseData,
      supplierBookings: snapshot.supplierBookings
    });
    return {
      externalBookingId: normalized.bookingKey,
      orderNumber: normalized.orderNumber,
      status: normalized.status,
      startsAt: normalized.dtFrom,
      endsAt: normalized.dtTo,
      quantity: normalized.guestCount,
      totalMinor: Math.round(normalized.totalAmount * 100),
      paidMinor: Math.round(normalized.paidAmount * 100),
      currency: 'EUR'
    };
  },
  async cancelBooking(input) {
    await regiondoClient.cancelTickets(input.referenceIds);
  }
};
