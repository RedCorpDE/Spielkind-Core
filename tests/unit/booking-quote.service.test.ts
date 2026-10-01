import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBookingOffering: vi.fn(),
  getVariantDurationMinutes: vi.fn(),
  providerGet: vi.fn(),
  quote: vi.fn(),
  poolQuery: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({ pool: { query: mocks.poolQuery } }));

vi.mock('../../src/modules/catalog/catalog.repository.js', () => ({
  getBookingOffering: mocks.getBookingOffering,
  getVariantDurationMinutes: mocks.getVariantDurationMinutes
}));
vi.mock('../../src/modules/bookings/booking-provider.js', () => ({
  bookingProviderRegistry: { get: mocks.providerGet }
}));
vi.mock('../../src/modules/pricing/pricing.service.js', () => ({
  pricingService: { quote: mocks.quote }
}));

const { quoteBookingIntent } = await import('../../src/modules/bookings/booking-quote.service.js');

const intent = {
  locationId: '11111111-1111-1111-1111-111111111111',
  productId: '22222222-2222-2222-2222-222222222222',
  locationProductId: '33333333-3333-3333-3333-333333333333',
  variantId: '44444444-4444-4444-4444-444444444444',
  startAt: '2026-10-16T16:00:00.000Z',
  endAt: '2026-10-16T18:00:00.000Z',
  participants: 4,
  options: [{ optionId: '55555555-5555-5555-5555-555555555555', value: 'yes' }]
};

const rules = {
  timeSelectionMode: 'start_end' as const,
  timezone: 'Europe/Berlin', minParticipants: 1, maxParticipants: 8,
  minDurationMinutes: 60, maxDurationMinutes: 480, durationStepMinutes: 30,
  defaultDurationMinutes: 120, allowedDurationMinutes: [], minAdvanceMinutes: 0,
  maxAdvanceDays: 365, sameDayBookingAllowed: true
  , pricingMode: 'per_quantity' as const, dateRangeBillingUnit: 'nights' as const
};

describe('shared booking quote service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVariantDurationMinutes.mockResolvedValue(null);
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT variant_id')) return { rows: [{
        variant_id: intent.variantId, title: 'Standard', is_active: true,
        schedule_rule_enabled: false, allowed_weekdays: null,
        local_start_time: null, local_end_time: null
      }], rowCount: 1 };
      return sql.includes('FROM product_variants')
        ? { rows: [{ duration_minutes: null }], rowCount: 1 }
        : { rows: [{ option_id: intent.options[0].optionId, duration_delta_minutes: 0 }], rowCount: 1 };
    });
    mocks.quote.mockResolvedValue({
      items: [], subtotalNet: 10000, tax: 1900, subtotalGross: 11900,
      discount: 0, total: 11900, currency: 'EUR'
    });
  });

  it.each(['core', 'regiondo'] as const)('normalizes %s availability and pricing', async (bookingProvider) => {
    mocks.getBookingOffering.mockResolvedValue({
      id: intent.locationProductId, locationId: intent.locationId, productId: intent.productId,
      active: true, bookingProvider, rules
    });
    mocks.providerGet.mockReturnValue({
      checkAvailability: vi.fn().mockResolvedValue({
        available: true, capacity: bookingProvider === 'core' ? 10 : null,
        reserved: null, held: null, remaining: null, maxBookableQuantity: null
      })
    });
    const quote = await quoteBookingIntent(intent, { now: new Date('2026-10-01T00:00:00Z') });
    expect(mocks.providerGet).toHaveBeenCalledWith(bookingProvider);
    expect(quote.available).toBe(true);
    expect(quote.configuration).toMatchObject({ startAt: intent.startAt, endAt: intent.endAt, participants: 4 });
    expect(quote.pricing).toMatchObject({ subtotal: 11900, fees: 0, taxes: 1900, discount: 0, total: 11900, currency: 'EUR' });
  });

  it('rejects inactive and mismatched offerings before provider access', async () => {
    mocks.getBookingOffering.mockResolvedValue({
      id: intent.locationProductId, locationId: intent.locationId, productId: intent.productId,
      active: false, bookingProvider: 'core', rules
    });
    await expect(quoteBookingIntent(intent)).rejects.toMatchObject({ code: 'OFFERING_INACTIVE' });
    mocks.getBookingOffering.mockResolvedValue({
      id: intent.locationProductId, locationId: intent.locationId, productId: 'different',
      active: true, bookingProvider: 'core', rules
    });
    await expect(quoteBookingIntent(intent)).rejects.toMatchObject({ code: 'INVALID_OFFERING_PAIRING' });
    expect(mocks.providerGet).not.toHaveBeenCalled();
  });

  it('checks Core availability with the resolved variant and option duration', async () => {
    const checkAvailability = vi.fn().mockResolvedValue({
      available: true, capacity: 10, reserved: 0, held: 0, remaining: 10, maxBookableQuantity: 10
    });
    mocks.getBookingOffering.mockResolvedValue({
      id: intent.locationProductId, locationId: intent.locationId, productId: intent.productId,
      active: true, bookingProvider: 'core', rules: { ...rules, timeSelectionMode: 'fixed_duration', defaultDurationMinutes: 240 }
    });
    mocks.providerGet.mockReturnValue({ checkAvailability });
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT variant_id')) return { rows: [{
        variant_id: intent.variantId, title: 'Extended', is_active: true,
        schedule_rule_enabled: false, allowed_weekdays: null,
        local_start_time: null, local_end_time: null
      }], rowCount: 1 };
      return sql.includes('FROM product_variants')
        ? { rows: [{ duration_minutes: 360 }], rowCount: 1 }
        : { rows: [{ option_id: intent.options[0].optionId, duration_delta_minutes: 60 }], rowCount: 1 };
    });

    const quote = await quoteBookingIntent(intent, { now: new Date('2026-10-01T00:00:00Z') });

    expect(quote.effectiveDurationMinutes).toBe(420);
    expect(quote.configuration.endAt).toBe('2026-10-16T23:00:00.000Z');
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ startAt: intent.startAt, endAt: '2026-10-16T23:00:00.000Z' })
    }));
  });

  it('rejects a schedule-ineligible Variant before shared client/web provider access', async () => {
    mocks.getBookingOffering.mockResolvedValue({
      id: intent.locationProductId,
      locationId: intent.locationId,
      productId: intent.productId,
      active: true,
      bookingProvider: 'core',
      rules
    });
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT variant_id')) {
        return {
          rows: [{
            variant_id: intent.variantId,
            title: 'Weekend',
            is_active: true,
            schedule_rule_enabled: true,
            allowed_weekdays: [6, 7],
            local_start_time: null,
            local_end_time: null
          }],
          rowCount: 1
        };
      }
      return sql.includes('FROM product_variants')
        ? { rows: [{ duration_minutes: null }], rowCount: 1 }
        : { rows: [{ option_id: intent.options[0].optionId, duration_delta_minutes: 0 }], rowCount: 1 };
    });

    await expect(
      quoteBookingIntent(intent, { now: new Date('2026-10-01T00:00:00Z') })
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_AVAILABLE_FOR_SCHEDULE' });
    expect(mocks.providerGet).not.toHaveBeenCalled();
  });
});

