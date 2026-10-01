import { describe, expect, it } from 'vitest';
import {
  buildBookingConfiguration,
  validateBookingRules
} from '../../src/modules/bookings/booking-configuration.service.js';
import type { BookingIntent, OfferingBookingRules } from '../../src/modules/bookings/booking-intent.js';

const baseRules: OfferingBookingRules = {
  timeSelectionMode: 'start_end',
  timezone: 'Europe/Berlin',
  minParticipants: 1,
  maxParticipants: 8,
  minDurationMinutes: 60,
  maxDurationMinutes: 480,
  durationStepMinutes: 30,
  defaultDurationMinutes: 120,
  allowedDurationMinutes: [],
  minAdvanceMinutes: 0,
  maxAdvanceDays: 365,
  sameDayBookingAllowed: true
  , pricingMode: 'per_quantity'
  , dateRangeBillingUnit: 'nights'
};

const intent = (minutes: number, participants = 2): BookingIntent => ({
  locationId: '11111111-1111-1111-1111-111111111111',
  productId: '22222222-2222-2222-2222-222222222222',
  locationProductId: '33333333-3333-3333-3333-333333333333',
  startAt: '2026-10-16T16:00:00.000Z',
  endAt: new Date(Date.parse('2026-10-16T16:00:00.000Z') + minutes * 60_000).toISOString(),
  participants,
  options: []
});

describe('offering booking configuration', () => {
  it.each([
    ['date_range', 24 * 60],
    ['start_end', 120],
    ['start_duration', 120]
  ] as const)('validates %s with canonical startAt/endAt', (mode, minutes) => {
    const rules = { ...baseRules, timeSelectionMode: mode, maxDurationMinutes: 2 * 24 * 60 };
    expect(validateBookingRules({ intent: intent(minutes), rules, now: new Date('2026-10-01T00:00:00Z') }))
      .toMatchObject({ participants: 2, durationMinutes: minutes });
  });

  it('enforces fixed and variant-defined duration', () => {
    const rules = { ...baseRules, timeSelectionMode: 'fixed_duration' as const };
    expect(() => validateBookingRules({
      intent: intent(120), rules, variantDurationMinutes: 240, now: new Date('2026-10-01T00:00:00Z')
    })).toThrow('Duration must be 240 minutes');
    expect(validateBookingRules({
      intent: intent(240), rules, variantDurationMinutes: 240, now: new Date('2026-10-01T00:00:00Z')
    }).durationMinutes).toBe(240);
  });

  it('enforces explicit non-linear durations and participant limits', () => {
    const rules = { ...baseRules, allowedDurationMinutes: [60, 120, 240, 480] };
    expect(() => validateBookingRules({ intent: intent(180), rules, now: new Date('2026-10-01T00:00:00Z') }))
      .toThrow('selected duration is not available');
    expect(() => validateBookingRules({ intent: intent(120, 9), rules, now: new Date('2026-10-01T00:00:00Z') }))
      .toThrow('Participants must be between 1 and 8');
  });

  it('builds normalized controls for all time selection modes', () => {
    for (const mode of ['date_range', 'start_end', 'start_duration', 'fixed_duration'] as const) {
      const configuration = buildBookingConfiguration({
        rules: { ...baseRules, timeSelectionMode: mode, allowedDurationMinutes: [60, 120] },
        variants: [{ id: 'variant', title: 'Premium', price: { amount: 5000, currency: 'EUR' }, durationMinutes: 120 }],
        options: [{ id: 'option', variantId: null, title: 'Catering', values: [{ value: 'yes', label: 'Yes' }], priceDelta: { amount: 1000, currency: 'EUR' } }]
      });
      expect(configuration.timeSelection.mode).toBe(mode);
      expect(configuration.participants).toEqual({ min: 1, max: 8, step: 1 });
      expect(configuration.variants[0].durationMinutes).toBe(120);
      expect(configuration.options[0].title).toBe('Catering');
    }
  });
});

