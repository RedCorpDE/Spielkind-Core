import { pool } from '../../db/pool.js';
import type { BookingIntent, BookingOffering, OfferingBookingRules } from './booking-intent.js';
import { assertSalesWindowOpen, BookingRuleValidationError, durationMinutes, validateBookingRules } from './booking-configuration.service.js';
import { getVariantEligibility } from './variant-eligibility.service.js';

const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface ResolvedBookingSchedule {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  effectiveDurationMinutes: number | null;
  timezone: string;
  billableDateUnits: number | null;
}

interface ScheduleSelection {
  variantDurationMinutes: number | null;
  optionDurationDeltaMinutes: number;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    throw new BookingRuleValidationError('The offering timezone is invalid.');
  }
}

function localParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localDateOrdinal(value: string, timezone: string): number {
  const parts = localParts(new Date(value), timezone);
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000);
}

export function calculateBillableDateUnits(input: {
  startsAt: string;
  endsAt: string;
  timezone: string;
  billingUnit: OfferingBookingRules['dateRangeBillingUnit'];
}): number {
  const difference = localDateOrdinal(input.endsAt, input.timezone) - localDateOrdinal(input.startsAt, input.timezone);
  const units = input.billingUnit === 'calendar_days' ? difference + 1 : difference;
  if (!Number.isInteger(units) || units < 1) {
    throw new BookingRuleValidationError('A date-range booking must contain at least one billable date unit.');
  }
  return units;
}

function localDate(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

/** Converts a venue-local date and clock time to an instant, including DST offset changes. */
export function localDateTimeToInstant(date: string, time: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !CLOCK_PATTERN.test(time)) {
    throw new BookingRuleValidationError('Fixed times must use valid date and HH:mm values.');
  }
  assertTimezone(timezone);
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = localParts(new Date(candidate), timezone);
    const observed = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    const adjustment = target - observed;
    candidate += adjustment;
    if (!adjustment) break;
  }
  const resolved = localParts(new Date(candidate), timezone);
  if (
    Number(resolved.year) !== year || Number(resolved.month) !== month || Number(resolved.day) !== day
    || Number(resolved.hour) !== hour || Number(resolved.minute) !== minute
  ) {
    throw new BookingRuleValidationError('The selected local time does not exist in the offering timezone.');
  }
  return new Date(candidate).toISOString();
}

function withLocalClock(
  value: string,
  requestedDate: string | undefined,
  requestedTime: string | undefined,
  fixedTime: string | null,
  timezone: string
): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BookingRuleValidationError('Booking times are invalid.');
  const parsedLocal = requestedDate ? localParts(parsed, timezone) : null;
  const clock = fixedTime?.slice(0, 5)
    ?? requestedTime
    ?? (parsedLocal ? `${parsedLocal.hour}:${parsedLocal.minute}` : undefined);
  return clock
    ? localDateTimeToInstant(requestedDate ?? localDate(parsed, timezone), clock, timezone)
    : parsed.toISOString();
}

export function resolveBookingSchedule(input: {
  intent: BookingIntent;
  rules: OfferingBookingRules;
  variantDurationMinutes?: number | null;
  optionDurationDeltaMinutes?: number;
  now?: Date;
  overrideBookingRules?: boolean;
}): ResolvedBookingSchedule {
  const { intent, rules } = input;
  assertTimezone(rules.timezone);
  assertSalesWindowOpen(rules, input.now);
  if (rules.dateSelection === 'fixed' && !rules.fixedDate) {
    throw new BookingRuleValidationError('A fixed booking date is required for this offering.');
  }
  if (rules.dateSelection === 'fixed' && intent.startDate && intent.startDate !== rules.fixedDate) {
    throw new BookingRuleValidationError(`Booking date must be ${rules.fixedDate}.`);
  }
  const resolvedStartDate = rules.dateSelection === 'fixed' ? rules.fixedDate ?? undefined : intent.startDate;
  const optionDelta = input.optionDurationDeltaMinutes ?? 0;
  const requestedDuration = intent.durationMinutes ?? null;
  const durationControlled = rules.timeSelectionMode === 'fixed_duration' || rules.timeSelectionMode === 'start_duration';
  const configuredBase = durationControlled
    ? input.variantDurationMinutes
      ?? (rules.timeSelectionMode === 'start_duration'
        ? requestedDuration ?? rules.defaultDurationMinutes
        : rules.defaultDurationMinutes ?? requestedDuration ?? durationMinutes(intent.startAt, intent.endAt))
    : null;
  if (durationControlled && configuredBase === null && optionDelta !== 0) {
    throw new BookingRuleValidationError('A duration adjustment requires a base duration.');
  }
  const effectiveDuration = configuredBase === null ? null : configuredBase + optionDelta;
  if (effectiveDuration !== null && (!Number.isInteger(effectiveDuration) || effectiveDuration <= 0)) {
    throw new BookingRuleValidationError('Effective duration must be greater than zero.');
  }

  let startsAt = withLocalClock(
    intent.startAt, resolvedStartDate, intent.startTime, rules.fixedStartTime ?? null, rules.timezone
  );
  const resolvedStartLocalDate = localDate(new Date(startsAt), rules.timezone);
  const requestedEndDate = rules.dateSelection === 'fixed'
    ? rules.fixedDate ?? undefined
    : intent.endDate;
  let endsAt = withLocalClock(
    intent.endAt, requestedEndDate, intent.endTime, durationControlled ? null : rules.fixedEndTime ?? null, rules.timezone
  );
  if (rules.timeSelectionMode === 'fixed_duration' || rules.timeSelectionMode === 'start_duration') {
    if (effectiveDuration === null) {
      throw new BookingRuleValidationError('A duration is required for this booking mode.');
    }
    endsAt = new Date(new Date(startsAt).getTime() + effectiveDuration * 60_000).toISOString();
    if (!rules.fixedStartTime) {
      const parts = localParts(new Date(startsAt), rules.timezone);
      const selectedClock = `${parts.hour}:${parts.minute}`;
      if (rules.earliestStartTime && selectedClock < rules.earliestStartTime) {
        throw new BookingRuleValidationError(`Start must not be before ${rules.earliestStartTime}.`);
      }
      if (rules.latestStartTime && selectedClock > rules.latestStartTime) {
        throw new BookingRuleValidationError(`Start must not be after ${rules.latestStartTime}.`);
      }
      const interval = rules.startIntervalMinutes ?? 30;
      const anchor = clockMinutes(rules.earliestStartTime ?? '00:00');
      if ((clockMinutes(selectedClock) - anchor) % interval !== 0) {
        throw new BookingRuleValidationError(`Start must use ${interval}-minute intervals.`);
      }
    }
  } else if (rules.dateSelection === 'fixed' && new Date(endsAt) <= new Date(startsAt)) {
    const endClock = rules.fixedEndTime ?? intent.endTime;
    if (!endClock) throw new BookingRuleValidationError('endAt must be after startAt.');
    endsAt = localDateTimeToInstant(addLocalDays(resolvedStartLocalDate, 1), endClock, rules.timezone);
  }

  const resolvedIntent: BookingIntent = { ...intent, startAt: startsAt, endAt: endsAt };
  const validated = input.overrideBookingRules
    ? {
        participants: intent.participants ?? intent.quantities?.participants ?? 1,
        durationMinutes: durationMinutes(startsAt, endsAt)
      }
    : validateBookingRules({
        intent: resolvedIntent,
        rules,
        variantDurationMinutes: rules.timeSelectionMode === 'fixed_duration' ? effectiveDuration : null,
        now: input.now
      });
  return {
    startsAt,
    endsAt,
    durationMinutes: validated.durationMinutes,
    effectiveDurationMinutes: effectiveDuration,
    timezone: rules.timezone,
    billableDateUnits: rules.timeSelectionMode === 'date_range'
      ? calculateBillableDateUnits({
          startsAt,
          endsAt,
          timezone: rules.timezone,
          billingUnit: rules.dateRangeBillingUnit
        })
      : null
  };
}

async function loadScheduleSelection(intent: BookingIntent): Promise<ScheduleSelection> {
  let variantDurationMinutes: number | null = null;
  if (intent.variantId) {
    const variant = await pool.query<{ duration_minutes: number | null }>(
      `SELECT duration_minutes FROM product_variants
       WHERE variant_id = $1 AND product_id = $2 AND regiondo_variant_id IS NULL LIMIT 1`,
      [intent.variantId, intent.productId]
    );
    if (!variant.rowCount) throw new BookingRuleValidationError('The selected variant does not belong to this Core product.');
    variantDurationMinutes = variant.rows[0].duration_minutes;
  }

  const optionIds = [...new Set((intent.options ?? []).map((option) => option.optionId))];
  if (!optionIds.length) return { variantDurationMinutes, optionDurationDeltaMinutes: 0 };
  const options = await pool.query<{ option_id: string; duration_delta_minutes: number }>(
    `SELECT option_id, duration_delta_minutes FROM product_options
     WHERE option_id = ANY($1::uuid[]) AND product_id = $2
       AND regiondo_option_id IS NULL
       AND ($3::uuid IS NULL OR variant_id IS NULL OR variant_id = $3::uuid)`,
    [optionIds, intent.productId, intent.variantId ?? null]
  );
  if (options.rows.length !== optionIds.length) {
    throw new BookingRuleValidationError('One or more selected options do not belong to the selected Core product and variant.');
  }
  return {
    variantDurationMinutes,
    optionDurationDeltaMinutes: options.rows.reduce((sum, option) => sum + Number(option.duration_delta_minutes), 0)
  };
}

export async function resolveCoreBookingSchedule(
  intent: BookingIntent,
  offering: BookingOffering,
  now?: Date,
  overrideBookingRules = false
): Promise<{ intent: BookingIntent; schedule: ResolvedBookingSchedule }> {
  if (offering.bookingProvider !== 'core') {
    throw new BookingRuleValidationError('Core schedule resolution only applies to Core-managed offerings.');
  }
  if (offering.id !== intent.locationProductId || offering.productId !== intent.productId || offering.locationId !== intent.locationId) {
    throw new BookingRuleValidationError('Product, location, and offering do not match.');
  }
  const selection = await loadScheduleSelection(intent);
  const schedule = resolveBookingSchedule({ intent, rules: offering.rules, ...selection, now, overrideBookingRules });
  await getVariantEligibility({
    productId: intent.productId,
    selectedVariantId: intent.variantId,
    startsAt: schedule.startsAt,
    timezone: offering.rules.timezone
  });
  return {
    intent: {
      ...intent,
      startAt: schedule.startsAt,
      endAt: schedule.endsAt,
      durationMinutes: schedule.effectiveDurationMinutes ?? intent.durationMinutes
    },
    schedule
  };
}
