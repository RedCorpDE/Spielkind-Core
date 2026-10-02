import { describe, expect, it } from 'vitest';
import { validateCancellationRules, validateNoShowPolicy } from '../../src/modules/cancellations/cancellation-policy.service.js';

describe('cancellation policy validation', () => {
  it('orders thresholds and accepts free, percentage, and fixed fees', () => {
    expect(validateCancellationRules([
      { minimumMinutesBeforeStart: 0, feeType: 'fixed_amount', feeValue: 1_000 },
      { minimumMinutesBeforeStart: 10_080, feeType: 'none' },
      { minimumMinutesBeforeStart: 1_440, feeType: 'percentage', feeValue: 25 }
    ]).map((rule) => rule.minimumMinutesBeforeStart)).toEqual([10_080, 1_440, 0]);
  });

  it('rejects duplicate thresholds and missing zero fallback', () => {
    expect(() => validateCancellationRules([
      { minimumMinutesBeforeStart: 0, feeType: 'none' },
      { minimumMinutesBeforeStart: 0, feeType: 'percentage', feeValue: 25 }
    ])).toThrow(/unique/);
    expect(() => validateCancellationRules([
      { minimumMinutesBeforeStart: 60, feeType: 'none' }
    ])).toThrow(/zero-minute/);
  });

  it('validates no-show grace and percentage limits', () => {
    expect(validateNoShowPolicy({ gracePeriodMinutes: 30, feeType: 'percentage', feeValue: 100 }))
      .toEqual({ gracePeriodMinutes: 30, feeType: 'percentage', feeValue: 100 });
    expect(() => validateNoShowPolicy({ gracePeriodMinutes: 30, feeType: 'percentage', feeValue: 101 }))
      .toThrow(/between 0 and 100/);
  });
});
