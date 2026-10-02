import { describe, expect, it } from 'vitest';
import type { BookingIntent, OfferingBookingRules } from '../../src/modules/bookings/booking-intent.js';
import { localDateTimeToInstant, resolveBookingSchedule } from '../../src/modules/bookings/booking-schedule.service.js';

const rules: OfferingBookingRules = {
  timeSelectionMode: 'fixed_duration',
  timezone: 'Europe/Berlin',
  fixedStartTime: null,
  fixedEndTime: null,
  minParticipants: 1,
  maxParticipants: 10,
  minDurationMinutes: null,
  maxDurationMinutes: null,
  durationStepMinutes: null,
  defaultDurationMinutes: 240,
  allowedDurationMinutes: [],
  minAdvanceMinutes: 0,
  maxAdvanceDays: null,
  sameDayBookingAllowed: true
  , pricingMode: 'per_quantity'
  , dateRangeBillingUnit: 'nights'
};

const intent: BookingIntent = {
  locationId: 'location',
  productId: 'product',
  locationProductId: 'offering',
  startAt: '2026-10-10T12:00:00.000Z',
  endAt: '2026-10-10T16:00:00.000Z',
  participants: 2,
  options: []
};

describe('Core booking schedule resolution', () => {
  it('uses the authoritative fixed local date when the client omits startDate', () => {
    const result = resolveBookingSchedule({
      intent: { ...intent, startTime: '18:00' },
      rules: { ...rules, dateSelection: 'fixed', fixedDate: '2026-12-05' },
      now: new Date('2026-10-01T00:00:00.000Z')
    });
    expect(result.startsAt).toBe('2026-12-05T17:00:00.000Z');
    expect(result.endsAt).toBe('2026-12-05T21:00:00.000Z');
  });

  it('rewrites a manipulated startAt date even when no local date fields are supplied', () => {
    const result = resolveBookingSchedule({
      intent,
      rules: { ...rules, dateSelection: 'fixed', fixedDate: '2026-12-05' },
      now: new Date('2026-10-01T00:00:00.000Z')
    });
    expect(result.startsAt.slice(0, 10)).toBe('2026-12-05');
    expect(result.endsAt.slice(0, 10)).toBe('2026-12-05');
  });

  it('rejects a conflicting explicit date for a fixed-date offering', () => {
    expect(() => resolveBookingSchedule({
      intent: { ...intent, startDate: '2026-12-06', startTime: '18:00' },
      rules: { ...rules, dateSelection: 'fixed', fixedDate: '2026-12-05' },
      now: new Date('2026-10-01T00:00:00.000Z')
    })).toThrow('Booking date must be 2026-12-05');
  });

  it.each([
    ['2026-09-30T23:59:59.000Z', 'not open yet'],
    ['2026-12-05T00:00:01.000Z', 'closed']
  ])('enforces the sales window at %s', (now, message) => {
    expect(() => resolveBookingSchedule({
      intent,
      rules: {
        ...rules,
        salesOpenAt: '2026-10-01T00:00:00.000Z',
        salesCloseAt: '2026-12-04T23:59:59.000Z'
      },
      now: new Date(now)
    })).toThrow(message);
  });

  it('allows booking inside the independent sales window', () => {
    expect(resolveBookingSchedule({
      intent,
      rules: {
        ...rules,
        salesOpenAt: '2026-10-01T00:00:00.000Z',
        salesCloseAt: '2026-12-04T23:59:59.000Z'
      },
      now: new Date('2026-10-01T00:00:00.000Z')
    }).startsAt).toBe(intent.startAt);
  });

  it.each([
    [null, 60, 300],
    [360, 60, 420],
    [360, 0, 360]
  ])('applies product, variant, and option duration precedence', (variantDuration, delta, expected) => {
    const result = resolveBookingSchedule({
      intent,
      rules,
      variantDurationMinutes: variantDuration,
      optionDurationDeltaMinutes: delta,
      now: new Date('2026-01-01T00:00:00.000Z')
    });
    expect(result.effectiveDurationMinutes).toBe(expected);
    expect(new Date(result.endsAt).getTime() - new Date(result.startsAt).getTime()).toBe(expected * 60_000);
  });

  it('resolves fixed date-range clocks in the offering timezone', () => {
    const result = resolveBookingSchedule({
      intent: {
        ...intent,
        startAt: '2026-10-10T00:00:00.000Z',
        endAt: '2026-10-12T00:00:00.000Z'
      },
      rules: {
        ...rules,
        timeSelectionMode: 'date_range',
        fixedStartTime: '15:00',
        fixedEndTime: '10:00'
      },
      now: new Date('2026-01-01T00:00:00.000Z')
    });
    expect(result.startsAt).toBe('2026-10-10T13:00:00.000Z');
    expect(result.endsAt).toBe('2026-10-12T08:00:00.000Z');
  });

  it('uses the correct offset on each side of a DST change', () => {
    expect(localDateTimeToInstant('2026-03-28', '15:00', 'Europe/Berlin')).toBe('2026-03-28T14:00:00.000Z');
    expect(localDateTimeToInstant('2026-03-30', '10:00', 'Europe/Berlin')).toBe('2026-03-30T08:00:00.000Z');
  });

  it('counts local calendar nights across a DST transition', () => {
    const result = resolveBookingSchedule({
      intent: { ...intent, startAt: '2026-03-28T00:00:00.000Z', endAt: '2026-03-30T00:00:00.000Z' },
      rules: { ...rules, timeSelectionMode: 'date_range', fixedStartTime: '15:00', fixedEndTime: '10:00' },
      now: new Date('2026-01-01T00:00:00.000Z')
    });
    expect(result.billableDateUnits).toBe(2);
  });

  it('counts calendar-day billing inclusively', () => {
    const result = resolveBookingSchedule({
      intent: { ...intent, startAt: '2026-10-10T00:00:00.000Z', endAt: '2026-10-12T00:00:00.000Z' },
      rules: {
        ...rules,
        timeSelectionMode: 'date_range',
        fixedStartTime: '15:00',
        fixedEndTime: '10:00',
        dateRangeBillingUnit: 'calendar_days'
      },
      now: new Date('2026-01-01T00:00:00.000Z')
    });
    expect(result.billableDateUnits).toBe(3);
  });

  it('rejects a non-positive effective duration', () => {
    expect(() => resolveBookingSchedule({
      intent,
      rules,
      optionDurationDeltaMinutes: -240,
      now: new Date('2026-01-01T00:00:00.000Z')
    })).toThrow('Effective duration must be greater than zero');
  });
});
