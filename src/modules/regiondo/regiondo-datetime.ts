const REGIONDO_SOURCE_TIME_ZONE = 'Europe/Berlin';
const REGIONDO_EXPLICIT_TIME_ZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;
const REGIONDO_NAIVE_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const berlinDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REGIONDO_SOURCE_TIME_ZONE,
  hour12: false,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function readBerlinDateTimeParts(value: Date): DateTimeParts {
  const parts = berlinDateTimeFormatter.formatToParts(value);
  const values = parts.reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }

    return result;
  }, {});

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function parseNaiveRegiondoDateTimeParts(value: string): DateTimeParts | null {
  const match = REGIONDO_NAIVE_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? '0'),
    minute: Number(match[5] ?? '0'),
    second: Number(match[6] ?? '0')
  };
}

function getBerlinOffsetMs(value: Date): number {
  const parts = readBerlinDateTimeParts(value);
  const berlinAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return berlinAsUtc - value.getTime();
}

function sameBerlinDateTimeParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

export function parseRegiondoDateTime(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (REGIONDO_EXPLICIT_TIME_ZONE_PATTERN.test(trimmed)) {
    const explicitDate = new Date(trimmed);
    return Number.isNaN(explicitDate.getTime()) ? null : explicitDate;
  }

  const naiveParts = parseNaiveRegiondoDateTimeParts(trimmed);
  if (!naiveParts) {
    return null;
  }

  const utcGuess = Date.UTC(
    naiveParts.year,
    naiveParts.month - 1,
    naiveParts.day,
    naiveParts.hour,
    naiveParts.minute,
    naiveParts.second
  );
  const initialOffsetMs = getBerlinOffsetMs(new Date(utcGuess));
  let candidate = new Date(utcGuess - initialOffsetMs);
  const correctedOffsetMs = getBerlinOffsetMs(candidate);

  if (correctedOffsetMs !== initialOffsetMs) {
    candidate = new Date(utcGuess - correctedOffsetMs);
  }

  if (Number.isNaN(candidate.getTime())) {
    return null;
  }

  return sameBerlinDateTimeParts(readBerlinDateTimeParts(candidate), naiveParts) ? candidate : null;
}
