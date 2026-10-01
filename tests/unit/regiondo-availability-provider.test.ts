import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getExternalVariantReference: vi.fn() }));

vi.mock('../../src/modules/catalog/catalog.repository.js', () => ({
  getExternalVariantReference: mocks.getExternalVariantReference
}));
vi.mock('../../src/modules/integrations/booking-providers/regiondo/regiondo-booking-create.service.js', () => ({
  createRegiondoBooking: vi.fn()
}));

const { regiondoBookingProvider } = await import(
  '../../src/modules/integrations/booking-providers/regiondo/regiondo-booking-provider.js'
);

const offering = {
  id: '33333333-3333-3333-3333-333333333333',
  locationId: '11111111-1111-1111-1111-111111111111',
  productId: '22222222-2222-2222-2222-222222222222',
  active: true,
  bookingProvider: 'regiondo' as const,
  rules: {
    timeSelectionMode: 'start_end' as const,
    timezone: 'Europe/Berlin',
    minParticipants: 1,
    maxParticipants: 10,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    durationStepMinutes: null,
    defaultDurationMinutes: null,
    allowedDurationMinutes: [],
    minAdvanceMinutes: 0,
    maxAdvanceDays: null,
    sameDayBookingAllowed: true
    , pricingMode: 'per_quantity'
    , dateRangeBillingUnit: 'nights'
  }
};

const intent = {
  locationId: offering.locationId,
  productId: offering.productId,
  locationProductId: offering.id,
  variantId: '44444444-4444-4444-4444-444444444444',
  startAt: '2026-10-16T16:00:00.000Z',
  endAt: '2026-10-16T18:00:00.000Z',
  participants: 2,
  options: []
};

describe('Regiondo normalized availability', () => {
  beforeEach(() => mocks.getExternalVariantReference.mockResolvedValue('720707'));
  afterEach(() => vi.restoreAllMocks());

  it('matches the requested instant using Regiondo Europe/Berlin wall time', async () => {
    vi.spyOn(regiondoBookingProvider, 'getAvailability').mockResolvedValue([
      { startsAt: '2026-10-16T17:00:00', available: true, remaining: null },
      { startsAt: '2026-10-16T18:00:00', available: true, remaining: null }
    ]);

    await expect(regiondoBookingProvider.checkAvailability!({ intent, offering })).resolves.toMatchObject({
      available: true,
      slots: [{ startsAt: '2026-10-16T18:00:00' }]
    });
  });

  it('does not report a different returned slot as availability for the quote interval', async () => {
    vi.spyOn(regiondoBookingProvider, 'getAvailability').mockResolvedValue([
      { startsAt: '2026-10-16T17:00:00', available: true, remaining: null }
    ]);

    await expect(regiondoBookingProvider.checkAvailability!({ intent, offering })).resolves.toMatchObject({
      available: false,
      slots: []
    });
  });
});
