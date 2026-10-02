import { describe, expect, it } from 'vitest';
import { calculateCancellationQuote, isNoShowEligible } from '../../src/modules/cancellations/cancellation.service.js';

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
    expect(quote.refundableAmount).toBe(10_000);
    expect(quote.refundAmount).toBe(5_000);
    expect(quote.cancellationFee).toBe(5_000);
  });

  it('selects exact minute boundaries deterministically', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 20_000, currency: 'EUR', status: 'confirmed',
      now: '2026-10-01T10:00:00.000Z', startsAt: '2026-10-02T10:00:00.000Z',
      rules: [
        { minimumMinutesBeforeStart: 10_080, feeType: 'none' },
        { minimumMinutesBeforeStart: 1_440, feeType: 'percentage', feeValue: 25 },
        { minimumMinutesBeforeStart: 0, feeType: 'percentage', feeValue: 100 }
      ]
    });
    expect(quote.cancellationFee).toBe(5_000);
    expect(quote.refundAmount).toBe(15_000);
  });

  it.each([
    [10_080, 0, 20_000],
    [10_079, 5_000, 15_000],
    [1_440, 5_000, 15_000],
    [1_439, 20_000, 0]
  ])('applies the expected tier at %i minutes', (minutes, expectedFee, expectedRefund) => {
    const now = new Date('2026-10-01T10:00:00.000Z');
    const quote = calculateCancellationQuote({
      bookingTotal: 20_000, currency: 'EUR', status: 'confirmed', now: now.toISOString(),
      startsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      rules: [
        { minimumMinutesBeforeStart: 10_080, feeType: 'none' },
        { minimumMinutesBeforeStart: 1_440, feeType: 'percentage', feeValue: 25 },
        { minimumMinutesBeforeStart: 0, feeType: 'percentage', feeValue: 100 }
      ]
    });
    expect(quote.cancellationFee).toBe(expectedFee);
    expect(quote.refundAmount).toBe(expectedRefund);
  });

  it('deducts a fixed fee in minor units', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 20_000, currency: 'EUR', status: 'confirmed',
      now: '2026-10-01T10:00:00.000Z', startsAt: '2026-10-02T10:00:00.000Z',
      rules: [{ minimumMinutesBeforeStart: 0, feeType: 'fixed_amount', feeValue: 2_500 }]
    });
    expect(quote.cancellationFee).toBe(2_500);
    expect(quote.refundAmount).toBe(17_500);
  });

  it('clamps a fixed fee to the paid amount', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 2_000, currency: 'EUR', status: 'confirmed',
      now: '2026-10-01T10:00:00.000Z', startsAt: '2026-10-02T10:00:00.000Z',
      rules: [{ minimumMinutesBeforeStart: 0, feeType: 'fixed_amount', feeValue: 2_500 }]
    });
    expect(quote.cancellationFee).toBe(2_000);
    expect(quote.refundAmount).toBe(0);
  });

  it('accounts for previous refunds without exceeding paid funds', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 20_000, paidAmount: 20_000, alreadyRefundedAmount: 5_000,
      currency: 'EUR', status: 'confirmed', now: '2026-10-01T10:00:00.000Z',
      startsAt: '2026-10-02T10:00:00.000Z',
      rules: [{ minimumMinutesBeforeStart: 0, feeType: 'none' }]
    });
    expect(quote.refundableAmount).toBe(15_000);
    expect(quote.refundAmount).toBe(15_000);
  });

  it('uses the snapshotted policy rules instead of later live rules', () => {
    const quote = calculateCancellationQuote({
      bookingTotal: 20_000, currency: 'EUR', status: 'confirmed',
      now: '2026-10-01T10:00:00.000Z', startsAt: '2026-10-02T10:00:00.000Z',
      rules: [{ minimumMinutesBeforeStart: 0, feeType: 'percentage', feeValue: 50 }],
      policy: {
        policyId: 'snapshot-policy', name: 'Standard',
        rules: [{ minimumMinutesBeforeStart: 0, feeType: 'percentage', feeValue: 25 }],
        noShow: { gracePeriodMinutes: 30, feeType: 'percentage', feeValue: 100 }
      }
    });
    expect(quote.cancellationFee).toBe(5_000);
    expect(quote.appliedPolicy.name).toBe('Standard');
  });
});

describe('no-show eligibility', () => {
  it('enforces the grace-period boundary using the server timestamp', () => {
    const startsAt = '2026-10-01T18:00:00.000Z';
    expect(isNoShowEligible(startsAt, 30, '2026-10-01T18:20:00.000Z')).toBe(false);
    expect(isNoShowEligible(startsAt, 30, '2026-10-01T18:30:00.000Z')).toBe(true);
    expect(isNoShowEligible(startsAt, 30, '2026-10-01T18:31:00.000Z')).toBe(true);
  });
});

