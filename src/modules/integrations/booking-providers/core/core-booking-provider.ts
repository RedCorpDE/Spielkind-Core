import type { BookingProvider, ProviderManagedBookingField } from '../../../bookings/booking-provider.js';
import { participantCount } from '../../../bookings/booking-intent.js';
import { getAvailabilitySummary } from '../../../resources/availability.service.js';
import { createNativeBooking } from '../../../bookings/native-booking.service.js';
import { getBookingOffering } from '../../../catalog/catalog.repository.js';
import { calculateBillableDateUnits } from '../../../bookings/booking-schedule.service.js';

export const coreBookingProvider: BookingProvider = {
  key: 'core',
  displayName: 'Core',
  supportsBookingUpdates: () => true,
  isProviderManagedField: (_field): _field is ProviderManagedBookingField => false,
  getExternalBookingUrl: () => null,
  async createBooking({ intent, clientId, idempotencyKey, holdId }) {
    if (!holdId) throw new Error('A reservation hold is required for a Core booking.');
    const offering = await getBookingOffering(intent.locationProductId);
    if (!offering || offering.bookingProvider !== 'core') throw new Error('The Core Product Offering was not found.');
    const dateUnits = offering.rules.timeSelectionMode === 'date_range'
      ? calculateBillableDateUnits({
          startsAt: intent.startAt,
          endsAt: intent.endAt,
          timezone: offering.rules.timezone,
          billingUnit: offering.rules.dateRangeBillingUnit
        })
      : 1;
    return createNativeBooking({
      clientId,
      locationId: intent.locationId,
      locationProductId: intent.locationProductId,
      productId: intent.productId,
      variantId: intent.variantId,
      options: (intent.options ?? []).map((option) => ({ optionId: option.optionId, value: option.value ?? '' })),
      quantity: participantCount(intent),
      startsAt: intent.startAt,
      endsAt: intent.endAt,
      holdId,
      idempotencyKey
      , dateUnits
    });
  },
  async checkAvailability({ intent, offering }) {
    const availability = await getAvailabilitySummary({
      product_id: intent.productId,
      product_variant_id: intent.variantId,
      location_id: intent.locationId,
      dt_from: intent.startAt,
      dt_to: intent.endAt,
      guest_count: participantCount(intent),
      max_quantity: offering.rules.maxParticipants
    });
    return {
      available: availability.available,
      capacity: availability.capacity,
      reserved: availability.reserved,
      held: availability.held,
      remaining: availability.remaining,
      maxBookableQuantity: availability.maxBookableQuantity
    };
  }
};
