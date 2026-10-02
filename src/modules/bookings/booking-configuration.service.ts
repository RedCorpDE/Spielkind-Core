import type { BookingIntent, OfferingBookingRules, SalesWindowStatus, TimeSelectionMode } from './booking-intent.js';

export class BookingRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingRuleValidationError';
  }
}

export function salesWindowStatus(
  rules: Pick<OfferingBookingRules, 'salesOpenAt' | 'salesCloseAt'>,
  now = new Date()
): SalesWindowStatus {
  const instant = now.getTime();
  if (rules.salesOpenAt && instant < new Date(rules.salesOpenAt).getTime()) return 'upcoming';
  if (rules.salesCloseAt && instant > new Date(rules.salesCloseAt).getTime()) return 'closed';
  return 'open';
}

export function assertSalesWindowOpen(
  rules: Pick<OfferingBookingRules, 'salesOpenAt' | 'salesCloseAt'>,
  now = new Date()
): void {
  const status = salesWindowStatus(rules, now);
  if (status === 'upcoming') throw new BookingRuleValidationError('Booking is not open yet.');
  if (status === 'closed') throw new BookingRuleValidationError('Booking is closed.');
}

export interface BookingConfigurationVariant {
  id: string;
  title: string | null;
  price: { amount: number; currency: string };
  durationMinutes?: number | null;
  active?: boolean;
  scheduleRule?: {
    enabled: boolean;
    allowedWeekdays: number[] | null;
    localStartTime: string | null;
    localEndTime: string | null;
  };
}

export interface BookingConfigurationOption {
  id: string;
  variantId: string | null;
  title: string;
  values: Array<{ value: string; label: string }>;
  priceDelta: { amount: number; currency: string };
  durationDeltaMinutes?: number;
}

function sameCalendarDate(left: Date, right: Date, timezone: string): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(left) === formatter.format(right);
}

export function durationMinutes(startAt: string, endAt: string): number {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new BookingRuleValidationError('endAt must be after startAt.');
  }
  const duration = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(duration)) {
    throw new BookingRuleValidationError('Booking duration must resolve to whole minutes.');
  }
  return duration;
}

export function validateBookingRules(input: {
  intent: BookingIntent;
  rules: OfferingBookingRules;
  variantDurationMinutes?: number | null;
  now?: Date;
}): { participants: number; durationMinutes: number } {
  const participants = input.intent.participants ?? input.intent.quantities?.participants ?? 1;
  if (!Number.isInteger(participants) || participants < input.rules.minParticipants || participants > input.rules.maxParticipants) {
    throw new BookingRuleValidationError(
      `Participants must be between ${input.rules.minParticipants} and ${input.rules.maxParticipants}.`
    );
  }

  const start = new Date(input.intent.startAt);
  const end = new Date(input.intent.endAt);
  const duration = durationMinutes(input.intent.startAt, input.intent.endAt);
  const now = input.now ?? new Date();
  const advanceMinutes = (start.getTime() - now.getTime()) / 60_000;
  if (advanceMinutes < input.rules.minAdvanceMinutes) {
    throw new BookingRuleValidationError('The booking does not meet the minimum advance time.');
  }
  if (input.rules.maxAdvanceDays !== null && advanceMinutes > input.rules.maxAdvanceDays * 24 * 60) {
    throw new BookingRuleValidationError('The booking is too far in advance.');
  }
  if (!input.rules.sameDayBookingAllowed && sameCalendarDate(start, now, input.rules.timezone)) {
    throw new BookingRuleValidationError('Same-day bookings are not allowed.');
  }
  if (input.rules.minDurationMinutes !== null && duration < input.rules.minDurationMinutes) {
    throw new BookingRuleValidationError(`Duration must be at least ${input.rules.minDurationMinutes} minutes.`);
  }
  if (input.rules.maxDurationMinutes !== null && duration > input.rules.maxDurationMinutes) {
    throw new BookingRuleValidationError(`Duration must be at most ${input.rules.maxDurationMinutes} minutes.`);
  }

  const expectedDuration = input.variantDurationMinutes ?? input.rules.defaultDurationMinutes;
  if (input.rules.timeSelectionMode === 'fixed_duration' && expectedDuration !== null && expectedDuration !== duration) {
    throw new BookingRuleValidationError(`Duration must be ${expectedDuration} minutes.`);
  }
  if (input.rules.allowedDurationMinutes.length && !input.rules.allowedDurationMinutes.includes(duration)) {
    throw new BookingRuleValidationError('The selected duration is not available.');
  }
  if (
    input.rules.durationStepMinutes !== null
    && input.rules.minDurationMinutes !== null
    && (duration - input.rules.minDurationMinutes) % input.rules.durationStepMinutes !== 0
  ) {
    throw new BookingRuleValidationError(`Duration must use ${input.rules.durationStepMinutes}-minute steps.`);
  }

  return { participants, durationMinutes: duration };
}

function timeFields(rules: OfferingBookingRules): Array<Record<string, unknown>> {
  const mode = rules.timeSelectionMode;
  const startType = rules.fixedStartTime ? 'date' : 'datetime';
  const endType = rules.fixedEndTime ? 'date' : 'datetime';
  if (mode === 'date_range') {
    return [
      { key: 'startAt', type: startType, label: 'Arrival', required: true },
      { key: 'endAt', type: endType, label: 'Departure', required: true }
    ];
  }
  if (mode === 'start_duration') {
    return [
      { key: 'startAt', type: startType, label: 'Start', required: true },
      { key: 'durationMinutes', type: 'duration', label: 'Duration', required: true }
    ];
  }
  if (mode === 'fixed_duration') {
    return [{ key: 'startAt', type: startType, label: 'Start', required: true }];
  }
  return [
    { key: 'startAt', type: startType, label: 'Start', required: true },
    { key: 'endAt', type: endType, label: 'End', required: true }
  ];
}

export function buildBookingConfiguration(input: {
  rules: OfferingBookingRules;
  variants: BookingConfigurationVariant[];
  options: BookingConfigurationOption[];
}) {
  const endTimeConfigurable = input.rules.timeSelectionMode === 'date_range' || input.rules.timeSelectionMode === 'start_end';
  const fixedEndTime = endTimeConfigurable ? input.rules.fixedEndTime ?? null : null;
  const durationValues = input.rules.allowedDurationMinutes.length
    ? input.rules.allowedDurationMinutes
    : undefined;
  const fields: Array<Record<string, unknown>> = [
    ...timeFields(input.rules),
    {
      key: 'participants',
      type: 'quantity',
      label: 'Participants',
      required: true,
      min: input.rules.minParticipants,
      max: input.rules.maxParticipants,
      step: 1
    }
  ];
  if (input.variants.length) {
    fields.push({
      key: 'variantId', type: 'variant', label: 'Booking option', required: true,
      values: input.variants.map((variant) => ({
        value: variant.id,
        label: variant.title ?? 'Standard',
        price: variant.price,
        durationMinutes: variant.durationMinutes ?? null,
        active: variant.active ?? true,
        scheduleRule: variant.scheduleRule ?? null
      }))
    });
  }
  for (const option of input.options) {
    if (!option.values.length) continue;
    fields.push({
      key: `option:${option.id}`,
      type: 'option',
      optionId: option.id,
      appliesToVariantId: option.variantId,
      label: option.title,
      required: false,
      values: option.values,
      priceDelta: option.priceDelta,
      durationDeltaMinutes: option.durationDeltaMinutes ?? 0
    });
  }

  return {
    timeSelection: {
      mode: input.rules.timeSelectionMode,
      timezone: input.rules.timezone,
      dateSelection: input.rules.dateSelection ?? 'customer',
      fixedDate: input.rules.fixedDate ?? null,
      startTimeSelection: input.rules.fixedStartTime ? 'fixed' : 'customer',
      endTimeSelection: fixedEndTime ? 'fixed' : 'customer',
      fixedStartTime: input.rules.fixedStartTime ?? null,
      fixedEndTime,
      earliestStartTime: input.rules.earliestStartTime ?? null,
      latestStartTime: input.rules.latestStartTime ?? null,
      startIntervalMinutes: input.rules.startIntervalMinutes ?? 30,
      baseDurationMinutes: input.rules.defaultDurationMinutes,
      ...(input.rules.timeSelectionMode === 'start_duration' || input.rules.timeSelectionMode === 'fixed_duration'
        ? {
            duration: {
              type: durationValues ? 'select' : 'range',
              valuesMinutes: durationValues,
              minMinutes: input.rules.minDurationMinutes,
              maxMinutes: input.rules.maxDurationMinutes,
              stepMinutes: input.rules.durationStepMinutes,
              defaultMinutes: input.rules.defaultDurationMinutes
            }
          }
        : {})
    },
    salesWindow: {
      opensAt: input.rules.salesOpenAt ?? null,
      closesAt: input.rules.salesCloseAt ?? null,
      status: salesWindowStatus(input.rules)
    },
    participants: { min: input.rules.minParticipants, max: input.rules.maxParticipants, step: 1 },
    pricing: {
      mode: input.rules.pricingMode,
      dateRangeBillingUnit: input.rules.dateRangeBillingUnit
    },
    variants: input.variants,
    options: input.options,
    // Compatibility for the current renderers while App and WordPress move to
    // the normalized timeSelection/participants contract.
    mode: 'normalized' as const,
    fields
  };
}

