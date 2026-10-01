import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/pool.js', () => ({ pool: { query } }));

const { getVariantEligibility } = await import('../../src/modules/bookings/variant-eligibility.service.js');

describe('Variant schedule eligibility', () => {
  beforeEach(() => query.mockReset());

  it('uses ISO weekdays in the Product Offering timezone', async () => {
    query.mockResolvedValue({ rows: [
      { variant_id: 'weekday', title: 'Weekday', is_active: true, schedule_rule_enabled: true, allowed_weekdays: [1,2,3,4,5], local_start_time: null, local_end_time: null },
      { variant_id: 'weekend', title: 'Weekend', is_active: true, schedule_rule_enabled: true, allowed_weekdays: [6,7], local_start_time: null, local_end_time: null }
    ] });
    const result = await getVariantEligibility({
      productId: 'product', startsAt: '2026-10-10T18:00:00.000Z', timezone: 'Europe/Berlin'
    });
    expect(result).toEqual([
      { id: 'weekday', eligible: false, reason: 'Not available on Saturday.' },
      { id: 'weekend', eligible: true }
    ]);
  });

  it('accepts local start windows and rejects manipulated selections', async () => {
    query.mockResolvedValue({ rows: [{
      variant_id: 'evening', title: 'Evening', is_active: true, schedule_rule_enabled: true,
      allowed_weekdays: [6], local_start_time: '18:00', local_end_time: '22:00'
    }] });
    await expect(getVariantEligibility({
      productId: 'product', selectedVariantId: 'evening', startsAt: '2026-10-10T17:00:00.000Z', timezone: 'Europe/Berlin'
    })).resolves.toEqual([{ id: 'evening', eligible: true }]);
    await expect(getVariantEligibility({
      productId: 'product', selectedVariantId: 'evening', startsAt: '2026-10-10T13:00:00.000Z', timezone: 'Europe/Berlin'
    })).rejects.toMatchObject({ code: 'VARIANT_NOT_AVAILABLE_FOR_SCHEDULE' });
  });

  it('supports local windows crossing midnight', async () => {
    query.mockResolvedValue({ rows: [{
      variant_id: 'night', title: 'Night', is_active: true, schedule_rule_enabled: true,
      allowed_weekdays: [6], local_start_time: '22:00', local_end_time: '03:00'
    }] });
    await expect(getVariantEligibility({
      productId: 'product', selectedVariantId: 'night', startsAt: '2026-10-10T21:30:00.000Z', timezone: 'Europe/Berlin'
    })).resolves.toEqual([{ id: 'night', eligible: true }]);
  });
});
