import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { BookingNotCancellableError } from '../bookings/booking.errors.js';
import { normalizeLifecycleStatus, transitionBookingInTransaction } from '../bookings/booking-lifecycle.service.js';
import type { CancellationFeeType, CancellationPolicyRule, CancellationPolicySnapshot, NoShowPolicy } from './cancellation-policy.service.js';

/** Legacy shape retained so pre-migration booking snapshots remain enforceable. */
export interface LegacyCancellationRule {
  minimumHoursBeforeStart: number;
  refundBasisPoints: number;
  reason?: string;
}
export type CancellationRule = CancellationPolicyRule | LegacyCancellationRule;

export interface AppliedPolicyResult {
  id: string | null;
  name: string;
  ruleDescription: string;
  feeType: CancellationFeeType;
  feeValue: number;
  minimumMinutesBeforeStart: number | null;
  summary: string[];
}

export interface CancellationQuote {
  bookingId: string | null;
  canCancel: boolean;
  originalAmount: number;
  bookingTotal: number;
  alreadyRefundedAmount: number;
  refundableAmount: number;
  cancellationFee: number;
  refundAmount: number;
  currency: string;
  reason: string;
  deadline: string | null;
  minutesBeforeStart: number;
  appliedPolicy: AppliedPolicyResult;
}

interface QuoteInput {
  bookingId?: string;
  bookingTotal: number;
  paidAmount?: number;
  alreadyRefundedAmount?: number;
  currency: string;
  startsAt: string;
  now: string;
  status: string;
  bookingProvider?: 'core' | 'regiondo';
  rules: CancellationRule[];
  policy?: Pick<CancellationPolicySnapshot, 'policyId' | 'name' | 'rules' | 'noShow'> | null;
}

function normalizedRule(rule: CancellationRule): CancellationPolicyRule {
  if ('minimumMinutesBeforeStart' in rule) return rule;
  const refundPercent = Math.max(0, Math.min(100, rule.refundBasisPoints / 100));
  return {
    minimumMinutesBeforeStart: rule.minimumHoursBeforeStart * 60,
    feeType: refundPercent >= 100 ? 'none' : 'percentage',
    feeValue: refundPercent >= 100 ? undefined : 100 - refundPercent,
    description: rule.reason
  };
}

function feeForAmount(amount: number, feeType: CancellationFeeType, feeValue = 0): number {
  if (feeType === 'none') return 0;
  if (feeType === 'fixed_amount') return Math.min(amount, feeValue);
  return Math.min(amount, Math.round(amount * feeValue / 100));
}

export function isNoShowEligible(startsAt: string, gracePeriodMinutes: number, now: string): boolean {
  const eligibleAt = new Date(startsAt).getTime() + gracePeriodMinutes * 60_000;
  return new Date(now).getTime() >= eligibleAt;
}

function describeRule(rule: CancellationPolicyRule): string {
  if (rule.description) return rule.description;
  if (rule.feeType === 'none') return 'Free cancellation';
  if (rule.feeType === 'percentage') return `${rule.feeValue ?? 0}% cancellation fee`;
  return `${rule.feeValue ?? 0} minor-unit cancellation fee`;
}

export function calculateCancellationQuote(input: QuoteInput): CancellationQuote {
  const status = normalizeLifecycleStatus(input.status);
  const originalAmount = Math.max(0, Math.trunc(input.bookingTotal));
  const paidAmount = Math.max(0, Math.trunc(input.paidAmount ?? originalAmount));
  const alreadyRefundedAmount = Math.max(0, Math.min(paidAmount, Math.trunc(input.alreadyRefundedAmount ?? 0)));
  const refundableAmount = Math.max(0, paidAmount - alreadyRefundedAmount);
  const minutesBeforeStart = Math.floor((new Date(input.startsAt).getTime() - new Date(input.now).getTime()) / 60_000);
  const rules = (input.policy?.rules ?? input.rules.map(normalizedRule))
    .map(normalizedRule)
    .sort((left, right) => right.minimumMinutesBeforeStart - left.minimumMinutesBeforeStart);
  const matching = rules.find((rule) => minutesBeforeStart >= rule.minimumMinutesBeforeStart);
  const fallback: CancellationPolicyRule = {
    minimumMinutesBeforeStart: 0,
    feeType: input.bookingProvider === 'regiondo' ? 'percentage' : 'none',
    feeValue: input.bookingProvider === 'regiondo' ? 100 : undefined,
    description: input.bookingProvider === 'regiondo'
      ? 'Refund amount requires confirmation from the external provider.'
      : 'No restrictive cancellation policy applies.'
  };
  const applied = matching ?? fallback;
  const policyFee = feeForAmount(originalAmount, applied.feeType, applied.feeValue);
  const refundAmount = Math.max(0, Math.min(refundableAmount, originalAmount - policyFee - alreadyRefundedAmount));
  const cancellationFee = Math.max(0, originalAmount - alreadyRefundedAmount - refundAmount);
  const blockedReason = ['cancelled', 'completed', 'expired', 'no_show'].includes(status)
    ? `Booking is already ${status}.`
    : minutesBeforeStart <= 0 ? 'Booking has already started.' : null;
  const policyName = input.policy?.name ?? (rules.length ? 'Booking cancellation policy' : 'Default cancellation behavior');
  return {
    bookingId: input.bookingId ?? null,
    canCancel: blockedReason === null,
    originalAmount,
    bookingTotal: originalAmount,
    alreadyRefundedAmount,
    refundableAmount,
    cancellationFee: blockedReason ? refundableAmount : cancellationFee,
    refundAmount: blockedReason ? 0 : refundAmount,
    currency: input.currency,
    reason: blockedReason ?? describeRule(applied),
    deadline: blockedReason ? null : input.startsAt,
    minutesBeforeStart,
    appliedPolicy: {
      id: input.policy?.policyId ?? null,
      name: policyName,
      ruleDescription: describeRule(applied),
      feeType: applied.feeType,
      feeValue: applied.feeValue ?? 0,
      minimumMinutesBeforeStart: applied.minimumMinutesBeforeStart,
      summary: rules.map((rule) => `${rule.minimumMinutesBeforeStart} minutes: ${describeRule(rule)}`)
    }
  };
}

function parsePolicySnapshot(value: unknown): Pick<CancellationPolicySnapshot, 'policyId' | 'name' | 'rules' | 'noShow'> | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const candidate = value as Partial<CancellationPolicySnapshot>;
  if (!Array.isArray(candidate.rules) || typeof candidate.name !== 'string') return null;
  return {
    policyId: typeof candidate.policyId === 'string' ? candidate.policyId : null,
    name: candidate.name,
    rules: candidate.rules,
    noShow: candidate.noShow ?? { gracePeriodMinutes: 0, feeType: 'percentage', feeValue: 100 }
  };
}

export async function getCancellationQuote(bookingId: string): Promise<CancellationQuote> {
  const result = await pool.query<{
    status: string; booking_provider: 'core' | 'regiondo'; dt_from: string; currency: string;
    total_minor: string | number; paid_minor: string | number; refunded_minor: string | number; snapshot: unknown;
  }>(
    `SELECT booking.status, booking.booking_provider, booking.dt_from, booking.currency,
            COALESCE((SELECT SUM(item.subtotal_gross) FROM booking_items item WHERE item.booking_id = booking.booking_id),
                     ROUND(booking.total_amount * 100)::bigint, 0) AS total_minor,
            GREATEST(COALESCE((SELECT SUM(payment.amount_minor) FROM payments payment
              WHERE payment.booking_id = booking.booking_id
                AND payment.status IN ('succeeded', 'partially_refunded', 'refunded')), 0),
              COALESCE(ROUND(booking.paid_amount * 100)::bigint, 0)) AS paid_minor,
            COALESCE((SELECT SUM(refund.amount_minor) FROM refunds refund
              WHERE refund.booking_id = booking.booking_id
                AND refund.status IN ('pending', 'processing', 'succeeded')), 0) AS refunded_minor,
            booking.cancellation_policy_snapshot AS snapshot
     FROM bookings booking WHERE booking.booking_id = $1 LIMIT 1`,
    [bookingId]
  );
  if (!result.rowCount) throw new Error('Booking was not found.');
  const row = result.rows[0];
  const policy = parsePolicySnapshot(row.snapshot);
  const legacyRules = Array.isArray(row.snapshot) ? row.snapshot.filter(isCancellationRule) : [];
  return calculateCancellationQuote({
    bookingId, bookingTotal: Number(row.total_minor), paidAmount: Number(row.paid_minor),
    alreadyRefundedAmount: Number(row.refunded_minor), currency: row.currency, startsAt: row.dt_from,
    now: new Date().toISOString(), status: row.status, bookingProvider: row.booking_provider,
    rules: legacyRules, policy
  });
}

function isCancellationRule(value: unknown): value is CancellationRule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isFinite(candidate.minimumMinutesBeforeStart) || Number.isFinite(candidate.minimumHoursBeforeStart);
}

export async function getNoShowQuote(bookingId: string, now = new Date().toISOString()): Promise<CancellationQuote & { eligibleAt: string }> {
  const result = await pool.query<{
    status: string; booking_provider: 'core' | 'regiondo'; dt_from: string; currency: string;
    total_minor: string | number; paid_minor: string | number; refunded_minor: string | number; snapshot: unknown;
  }>(
    `SELECT booking.status, booking.booking_provider, booking.dt_from, booking.currency,
      COALESCE((SELECT SUM(subtotal_gross) FROM booking_items WHERE booking_id = booking.booking_id), ROUND(booking.total_amount * 100)::bigint, 0) total_minor,
      GREATEST(COALESCE((SELECT SUM(amount_minor) FROM payments WHERE booking_id = booking.booking_id
        AND status IN ('succeeded','partially_refunded','refunded')), 0), COALESCE(ROUND(booking.paid_amount * 100)::bigint, 0)) paid_minor,
      COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE booking_id = booking.booking_id
        AND status IN ('pending','processing','succeeded')), 0) refunded_minor,
      booking.cancellation_policy_snapshot snapshot
     FROM bookings booking WHERE booking.booking_id = $1`, [bookingId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Booking was not found.');
  if (row.booking_provider === 'regiondo') throw new BookingNotCancellableError('Regiondo no-show behavior remains provider-managed.');
  const policy = parsePolicySnapshot(row.snapshot);
  const noShow: NoShowPolicy = policy?.noShow ?? { gracePeriodMinutes: 0, feeType: 'percentage', feeValue: 100 };
  const eligibleAt = new Date(new Date(row.dt_from).getTime() + noShow.gracePeriodMinutes * 60_000).toISOString();
  const paid = Number(row.paid_minor);
  const refunded = Number(row.refunded_minor);
  const remaining = Math.max(0, paid - refunded);
  const fee = feeForAmount(Number(row.total_minor), noShow.feeType, noShow.feeValue);
  const refundAmount = Math.max(0, Math.min(remaining, Number(row.total_minor) - fee - refunded));
  const validStatus = ['confirmed', 'checked_in'].includes(normalizeLifecycleStatus(row.status));
  const eligible = validStatus && isNoShowEligible(row.dt_from, noShow.gracePeriodMinutes, now);
  return {
    bookingId, canCancel: eligible, originalAmount: Number(row.total_minor), bookingTotal: Number(row.total_minor),
    alreadyRefundedAmount: refunded, refundableAmount: remaining, cancellationFee: remaining - refundAmount,
    refundAmount, currency: row.currency, reason: eligible ? 'No-show policy applies.' : `No-show can be marked after ${eligibleAt}.`,
    deadline: null, minutesBeforeStart: Math.floor((new Date(row.dt_from).getTime() - new Date(now).getTime()) / 60_000),
    appliedPolicy: {
      id: policy?.policyId ?? null, name: policy?.name ?? 'Default no-show behavior',
      ruleDescription: describeRule({ minimumMinutesBeforeStart: 0, feeType: noShow.feeType, feeValue: noShow.feeValue }),
      feeType: noShow.feeType, feeValue: noShow.feeValue ?? 0, minimumMinutesBeforeStart: null, summary: []
    }, eligibleAt
  };
}

export async function requestCancellation(bookingId: string): Promise<{ status: 'cancelled' | 'cancel_requested'; quote: CancellationQuote }> {
  const quote = await getCancellationQuote(bookingId);
  if (!quote.canCancel) {
    const current = await pool.query<{ status: string }>(`SELECT status FROM bookings WHERE booking_id = $1`, [bookingId]);
    if (current.rowCount && normalizeLifecycleStatus(current.rows[0].status) === 'cancelled') return { status: 'cancelled', quote };
    throw new BookingNotCancellableError(quote.reason);
  }
  return withTransaction(async (client) => {
    const booking = await client.query<{ booking_provider: string }>(
      `SELECT booking_provider FROM bookings WHERE booking_id = $1 FOR UPDATE`, [bookingId]
    );
    const requiresRefund = quote.refundAmount > 0;
    const requiresProviderCancellation = booking.rows[0]?.booking_provider === 'regiondo';
    if (requiresRefund || requiresProviderCancellation) {
      await transitionBookingInTransaction(client, bookingId, 'cancel_requested', { refundAmount: quote.refundAmount });
      return { status: 'cancel_requested' as const, quote };
    }
    await transitionBookingInTransaction(client, bookingId, 'cancelled', { refundAmount: 0 });
    await client.query(`DELETE FROM consumptions WHERE booking_id = $1 AND dt_to > now()`, [bookingId]);
    await client.query(`UPDATE access_credentials SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE booking_id = $1 AND status IN ('pending', 'active')`, [bookingId]);
    await client.query(`UPDATE reservation_holds SET status = 'released', updated_at = now()
      WHERE booking_id = $1 AND status = 'active'`, [bookingId]);
    return { status: 'cancelled' as const, quote };
  });
}
