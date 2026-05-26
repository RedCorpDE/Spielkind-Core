import { describe, expect, it } from 'vitest';
import {
  formatRegiondoDateTime,
  parseRegiondoDateTime
} from '../../src/modules/regiondo/regiondo-datetime.js';

describe('parseRegiondoDateTime', () => {
  it('parses summer Regiondo timestamps in Europe/Berlin instead of the host timezone', () => {
    expect(parseRegiondoDateTime('2026-05-05 13:00:00')?.toISOString()).toBe('2026-05-05T11:00:00.000Z');
  });

  it('parses winter Regiondo timestamps in Europe/Berlin instead of the host timezone', () => {
    expect(parseRegiondoDateTime('2026-01-05 13:00:00')?.toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });

  it('preserves explicit Regiondo offsets as-is', () => {
    expect(parseRegiondoDateTime('2026-05-12T14:17:29+00:00')?.toISOString()).toBe('2026-05-12T14:17:29.000Z');
  });

  it('formats explicit UTC timestamps back into Europe/Berlin local time for outbound requests', () => {
    expect(formatRegiondoDateTime('2026-05-05T11:00:00.000Z')).toBe('2026-05-05 13:00:00');
  });

  it('preserves naive Europe/Berlin timestamps when formatting outbound Regiondo requests', () => {
    expect(formatRegiondoDateTime('2026-01-05 13:00:00')).toBe('2026-01-05 13:00:00');
  });
});
