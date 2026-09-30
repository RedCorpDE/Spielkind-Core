import type { BookingProvider, ProviderManagedBookingField } from '../../../bookings/booking-provider.js';
import { participantCount } from '../../../bookings/booking-intent.js';
import { getAvailabilitySummary } from '../../../resources/availability.service.js';
import { createNativeBooking } from '../../../bookings/native-booking.service.js';

export const coreBookingProvider: BookingProvider = {
  key: 'core',
  displayName: 'Core',
  supportsBookingUpdates: () => true,
  isProviderManagedField: (_field): _field is ProviderManagedBookingField => false,
  getExternalBookingUrl: () => null,
  async createBooking({ intent, clientId, idempotencyKey, holdId }) {
    if (!holdId) throw new Error('A reservation hold is required for a Core booking.');
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
    });
  },
  async checkAvailability({ intent }) {
    const availability = await getAvailabilitySummary({
      product_id: intent.productId,
      product_variant_id: intent.variantId,
      location_id: intent.locationId,
      dt_from: intent.startAt,
      dt_to: intent.endAt,
      guest_count: participantCount(intent)
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
