import { pool } from '../../db/pool.js';
import type { BookingIntent, BookingOffering } from './booking-intent.js';
import { BookingRuleValidationError } from './booking-configuration.service.js';
import { localDateTimeToInstant, resolveCoreBookingSchedule } from './booking-schedule.service.js';
import { getVariantEligibility, VariantNotAvailableForScheduleError, type VariantEligibility } from './variant-eligibility.service.js';
import { getAvailabilitySummary } from '../resources/availability.service.js';

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface AvailableStartSlot {
  startsAt: string;
  endsAt: string;
  available: true;
  remaining: number | null;
  maxBookableQuantity: number | null;
}

export interface CoreStartSlotResult {
  selectedDate: string;
  effectiveDurationMinutes: number | null;
  allowedStart: { min: string; max: string; intervalMinutes: number } | null;
  slots: AvailableStartSlot[];
  variants: VariantEligibility[];
  fixedStart: boolean;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

function minutesClock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function generateStartClocks(input: {
  requested: string; min: string; max: string; intervalMinutes: number; anchor?: string;
}): string[] {
  if (![input.requested, input.min, input.max].every((value) => CLOCK.test(value))) {
    throw new BookingRuleValidationError('Start-slot clocks must use HH:mm values.');
  }
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 1440) {
    throw new BookingRuleValidationError('The start interval must be between 1 and 1440 minutes.');
  }
  const minimum = clockMinutes(input.min);
  const maximum = clockMinutes(input.max);
  if (maximum < minimum) return [];
  const requested = Math.max(clockMinutes(input.requested), minimum);
  const anchor = clockMinutes(input.anchor ?? input.min);
  const first = anchor + Math.ceil((requested - anchor) / input.intervalMinutes) * input.intervalMinutes;
  const clocks: string[] = [];
  for (let value = first; value <= maximum; value += input.intervalMinutes) clocks.push(minutesClock(value));
  return clocks;
}

function localDateAndTime(value: string, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function variantWindow(variantId?: string): Promise<{ min: string | null; max: string | null }> {
  if (!variantId) return { min: null, max: null };
  const result = await pool.query<{ schedule_rule_enabled: boolean; local_start_time: string | null; local_end_time: string | null }>(
    `SELECT schedule_rule_enabled, to_char(local_start_time, 'HH24:MI') AS local_start_time,
            to_char(local_end_time, 'HH24:MI') AS local_end_time
     FROM product_variants WHERE variant_id = $1 AND regiondo_variant_id IS NULL LIMIT 1`,
    [variantId]
  );
  const row = result.rows[0];
  return row?.schedule_rule_enabled
    ? { min: row.local_start_time, max: row.local_end_time }
    : { min: null, max: null };
}

function laterClock(left: string, right?: string | null): string {
  return right && clockMinutes(right) > clockMinutes(left) ? right : left;
}

function earlierClock(left: string, right?: string | null): string {
  return right && clockMinutes(right) < clockMinutes(left) ? right : left;
}

function previousMinute(value: string): string {
  return minutesClock(Math.max(0, clockMinutes(value) - 1));
}

async function availabilityRuleWindow(input: {
  locationId: string; productId: string; variantId?: string; selectedDate: string; timezone: string;
}): Promise<{ min: string; max: string } | null | undefined> {
  const result = await pool.query<{
    product_id: string | null; rule_type: 'recurring' | 'date_range'; starts_at: string | null; ends_at: string | null;
    weekdays: number[] | null; local_start_time: string | null; local_end_time: string | null;
  }>(
    `SELECT product_id, rule_type, starts_at, ends_at, weekdays,
            to_char(local_start_time, 'HH24:MI') AS local_start_time,
            to_char(local_end_time, 'HH24:MI') AS local_end_time
     FROM availability_rules
     WHERE is_active = true AND rule_type IN ('recurring', 'date_range') AND resource_id IS NULL
       AND (location_id IS NULL OR location_id = $1)
       AND (product_id IS NULL OR product_id = $2)
       AND (product_variant_id IS NULL OR ($3::uuid IS NOT NULL AND product_variant_id = $3))`,
    [input.locationId, input.productId, input.variantId ?? null]
  );
  if (!result.rows.length) return undefined;
  const isoWeekday = new Date(`${input.selectedDate}T12:00:00.000Z`).getUTCDay() || 7;
  const scopeWindows = (productScope: boolean) => result.rows
    .filter((row) => productScope ? row.product_id === input.productId : row.product_id === null)
    .flatMap((row) => {
      if (row.rule_type === 'recurring') {
        return row.weekdays?.includes(isoWeekday) && row.local_start_time && row.local_end_time
          ? [{ min: row.local_start_time, max: row.local_end_time }]
          : [];
      }
      if (!row.starts_at || !row.ends_at) return [];
      const start = localDateAndTime(row.starts_at, input.timezone);
      const end = localDateAndTime(row.ends_at, input.timezone);
      if (input.selectedDate < start.date || input.selectedDate > end.date) return [];
      return [{
        min: input.selectedDate === start.date ? start.time : '00:00',
        max: input.selectedDate === end.date ? end.time : '23:59'
      }];
    });
  const envelope = (productScope: boolean) => {
    const configured = result.rows.some((row) => productScope ? row.product_id === input.productId : row.product_id === null);
    if (!configured) return undefined;
    const windows = scopeWindows(productScope);
    if (!windows.length) return null;
    return {
      min: windows.reduce((value, window) => earlierClock(value, window.min), '23:59'),
      max: windows.reduce((value, window) => laterClock(value, window.max), '00:00')
    };
  };
  const location = envelope(false);
  const product = envelope(true);
  if (location === null || product === null) return null;
  if (!location && !product) return undefined;
  return {
    min: laterClock(location?.min ?? '00:00', product?.min),
    max: earlierClock(location?.max ?? '23:59', product?.max)
  };
}

function canGenerateAlternativeStarts(offering: BookingOffering): boolean {
  return offering.rules.fixedStartTime == null
    && (offering.rules.timeSelectionMode === 'fixed_duration' || offering.rules.timeSelectionMode === 'start_duration');
}

export async function listCoreStartSlots(input: {
  intent: BookingIntent;
  offering: BookingOffering;
  requestedDate?: string;
  requestedTime?: string;
}): Promise<CoreStartSlotResult> {
  if (input.offering.bookingProvider !== 'core') {
    throw new BookingRuleValidationError('Core start slots only apply to Core-managed offerings.');
  }
  const local = localDateAndTime(input.intent.startAt, input.offering.rules.timezone);
  const selectedDate = input.requestedDate ?? input.intent.startDate ?? local.date;
  const requestedTime = input.requestedTime ?? input.intent.startTime ?? local.time;
  const intervalMinutes = input.offering.rules.startIntervalMinutes ?? 30;
  const selectedWindow = await variantWindow(input.intent.variantId);
  const ruleWindow = await availabilityRuleWindow({
    locationId: input.intent.locationId,
    productId: input.intent.productId,
    variantId: input.intent.variantId,
    selectedDate,
    timezone: input.offering.rules.timezone
  });
  const variantOvernight = Boolean(
    selectedWindow.min && selectedWindow.max
    && clockMinutes(selectedWindow.min) > clockMinutes(selectedWindow.max)
  );
  const min = laterClock(
    laterClock(input.offering.rules.earliestStartTime ?? '00:00', variantOvernight ? null : selectedWindow.min),
    ruleWindow?.min
  );
  const max = earlierClock(
    earlierClock(input.offering.rules.latestStartTime ?? '23:59', !variantOvernight && selectedWindow.max ? previousMinute(selectedWindow.max) : null),
    ruleWindow?.max
  );
  const requestedInstant = localDateTimeToInstant(selectedDate, requestedTime, input.offering.rules.timezone);
  const variants = await getVariantEligibility({
    productId: input.intent.productId,
    startsAt: requestedInstant,
    timezone: input.offering.rules.timezone
  });
  const fixedStart = !canGenerateAlternativeStarts(input.offering);
  const clocks = ruleWindow === null ? [] : fixedStart
    ? [input.offering.rules.fixedStartTime ?? requestedTime]
    : generateStartClocks({
        requested: requestedTime, min, max, intervalMinutes,
        anchor: input.offering.rules.earliestStartTime ?? '00:00'
      });
  const slots: AvailableStartSlot[] = [];
  let effectiveDurationMinutes: number | null = null;

  for (const clock of clocks) {
    try {
      const startsAt = localDateTimeToInstant(selectedDate, clock, input.offering.rules.timezone);
      const resolved = await resolveCoreBookingSchedule({
        ...input.intent,
        startAt: startsAt,
        startDate: selectedDate,
        startTime: clock
      }, input.offering);
      effectiveDurationMinutes ??= resolved.schedule.effectiveDurationMinutes ?? resolved.schedule.durationMinutes;
      const availability = await getAvailabilitySummary({
        product_id: input.intent.productId,
        product_variant_id: input.intent.variantId,
        location_id: input.intent.locationId,
        dt_from: resolved.schedule.startsAt,
        dt_to: resolved.schedule.endsAt,
        guest_count: input.intent.participants ?? input.intent.quantities?.participants ?? 1
      });
      if (!availability.available) continue;
      slots.push({
        startsAt: resolved.schedule.startsAt,
        endsAt: resolved.schedule.endsAt,
        available: true,
        remaining: availability.remaining,
        maxBookableQuantity: availability.maxBookableQuantity
      });
    } catch (error) {
      if (error instanceof BookingRuleValidationError || error instanceof VariantNotAvailableForScheduleError) continue;
      throw error;
    }
  }

  return {
    selectedDate,
    effectiveDurationMinutes,
    allowedStart: fixedStart || ruleWindow === null ? null : { min, max, intervalMinutes },
    slots,
    variants,
    fixedStart
  };
}
