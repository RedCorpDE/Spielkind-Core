import { describe, expect, it } from 'vitest';
import { calculateCancellationQuote } from '../../src/modules/cancellations/cancellation.service.js';

describe('cancellation quote', () => {
  it('selects the matching time threshold', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 10_000, currency: 'EUR', status: 'confirmed',
      now: '2026-09-28T10:00:00.000Z', startsAt: '2026-09-30T10:00:00.000Z',
      rules: [
        { minimumHoursBeforeStart: 72, refundBasisPoints: 10_000 },
        { minimumHoursBeforeStart: 24, refundBasisPoints: 5_000 },
        { minimumHoursBeforeStart: 0, refundBasisPoints: 0 }
      ]
    });
    expect(quote.refundableAmount).toBe(5_000);
    expect(quote.cancellationFee).toBe(5_000);
  });
});

