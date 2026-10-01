import { pool } from '../../db/pool.js';

export class VariantNotAvailableForScheduleError extends Error {
  readonly code = 'VARIANT_NOT_AVAILABLE_FOR_SCHEDULE';

  constructor(message: string) {
    super(message);
    this.name = 'VariantNotAvailableForScheduleError';
  }
}

interface VariantScheduleRow {
  variant_id: string;
  title: string | null;
  is_active: boolean;
  schedule_rule_enabled: boolean;
  allowed_weekdays: number[] | null;
  local_start_time: string | null;
  local_end_time: string | null;
}

export interface VariantEligibility {
  id: string;
  eligible: boolean;
  reason?: string;
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function localStartParts(startsAt: string, timezone: string): { weekday: number; time: string } {
  const date = new Date(startsAt);
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date);
  const weekday = WEEKDAY_NAMES.indexOf(weekdayName) + 1;
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { weekday, time: `${values.hour}:${values.minute}` };
}

function evaluate(row: VariantScheduleRow, startsAt: string, timezone: string): VariantEligibility {
  if (!row.is_active) return { id: row.variant_id, eligible: false, reason: 'This option is inactive.' };
  if (!row.schedule_rule_enabled) return { id: row.variant_id, eligible: true };
  const local = localStartParts(startsAt, timezone);
  if (row.allowed_weekdays?.length && !row.allowed_weekdays.includes(local.weekday)) {
    return { id: row.variant_id, eligible: false, reason: `Not available on ${WEEKDAY_NAMES[local.weekday - 1]}.` };
  }
  const start = row.local_start_time?.slice(0, 5) ?? null;
  const end = row.local_end_time?.slice(0, 5) ?? null;
  if (start && end) {
    const inside = start <= end
      ? local.time >= start && local.time < end
      : local.time >= start || local.time < end;
    if (!inside) return { id: row.variant_id, eligible: false, reason: `Available for starts from ${start} until ${end}.` };
  }
  return { id: row.variant_id, eligible: true };
}

export async function getVariantEligibility(input: {
  productId: string;
  selectedVariantId?: string;
  startsAt: string;
  timezone: string;
}): Promise<VariantEligibility[]> {
  const result = await pool.query<VariantScheduleRow>(
    `SELECT variant_id, title, is_active, schedule_rule_enabled,
            allowed_weekdays, local_start_time, local_end_time
     FROM product_variants
     WHERE product_id = $1 AND regiondo_variant_id IS NULL
     ORDER BY title NULLS LAST, variant_id`,
    [input.productId]
  );
  const eligibility = result.rows.map((row) => evaluate(row, input.startsAt, input.timezone));
  const selected = input.selectedVariantId
    ? eligibility.find((item) => item.id === input.selectedVariantId)
    : null;
  if (input.selectedVariantId && !selected) {
    throw new VariantNotAvailableForScheduleError('The selected Variant does not belong to this Core Product.');
  }
  if (selected && !selected.eligible) {
    throw new VariantNotAvailableForScheduleError(selected.reason ?? 'The selected Variant is not available for this schedule.');
  }
  return eligibility;
}
