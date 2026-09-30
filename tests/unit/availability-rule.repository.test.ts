import { describe, expect, it, vi } from 'vitest';
import { isIntervalAllowedByAvailabilityRules } from '../../src/modules/resources/availability-rule.repository.js';

describe('Availability Rule window enforcement', () => {
  it('keeps unconfigured scopes open for backwards compatibility', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ location_count: 0, location_matches: false, product_count: 0, product_matches: false }]
    });
    await expect(isIntervalAllowedByAvailabilityRules({ query } as never, {
      locationId: 'location', productId: 'product', startsAt: '2026-10-12T10:00:00.000Z', endsAt: '2026-10-12T12:00:00.000Z'
    })).resolves.toBe(true);
  });

  it('requires both configured Location and Offering windows to match', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ location_count: 1, location_matches: true, product_count: 1, product_matches: false }]
    });
    await expect(isIntervalAllowedByAvailabilityRules({ query } as never, {
      locationId: 'location', productId: 'product', productVariantId: 'variant',
      startsAt: '2026-10-12T10:00:00.000Z', endsAt: '2026-10-12T12:00:00.000Z'
    })).resolves.toBe(false);
    expect(query.mock.calls[0][0]).toContain("rule_type IN ('recurring', 'date_range')");
  });
});
