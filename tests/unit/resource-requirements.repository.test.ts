import { describe, expect, it, vi } from 'vitest';
import {
  calculateResourceCapacityUsed,
  loadResourceRequirements
} from '../../src/modules/resources/resource-requirements.repository.js';

describe('Offering Resource requirement resolution', () => {
  it.each([
    { requirementQuantity: 1, bookingQuantity: 5, scalingMode: 'per_quantity' as const, expected: 5 },
    { requirementQuantity: 1, bookingQuantity: 5, scalingMode: 'per_booking' as const, expected: 1 },
    { requirementQuantity: 2, bookingQuantity: 5, scalingMode: 'per_booking' as const, expected: 2 }
  ])('calculates $scalingMode capacity as $expected', ({ expected, ...input }) => {
    expect(calculateResourceCapacityUsed(input)).toBe(expected);
  });

  it('returns the centrally calculated per-quantity capacity requirement', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        resource_id: 'resource-1', resource_title: 'Gaming PCs', capacity_available: 40,
        quantity: '2', scaling_mode: 'per_quantity', source: 'offering'
      }]
    });
    const rows = await loadResourceRequirements({ query } as never, {
      productId: 'product-1', locationId: 'location-1', quantity: 3
    });
    expect(rows[0]).toMatchObject({ quantity: 2, scaling_mode: 'per_quantity', required_quantity: 6, source: 'offering' });
    expect(query.mock.calls[0][1]).toEqual(['product-1', 'location-1', true]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain('$4');
    expect(sql).toContain('$3::boolean');
  });

  it('returns the fixed per-booking capacity requirement regardless of participants', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        resource_id: 'flat-1', resource_title: 'LAN Flat A', capacity_available: 1,
        quantity: '1', scaling_mode: 'per_booking', source: 'offering'
      }]
    });
    const rows = await loadResourceRequirements({ query } as never, {
      productId: 'flat-product', locationId: 'location-1', quantity: 5
    });
    expect(rows[0]).toMatchObject({ required_quantity: 1, scaling_mode: 'per_booking' });
  });

  it('uses legacy Product Resources only when the Offering has no mappings', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await loadResourceRequirements({ query } as never, {
      productId: 'product-1', locationId: 'location-1', quantity: 1
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('product_offering_resources');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM has_offering_requirements)');
    expect(sql).toContain('resource.location_id = $2');
    expect(sql).toContain("'per_quantity'::text AS scaling_mode");
    expect(sql).toContain("offering.booking_provider = 'core'");
    expect(sql).not.toContain('UNION DISTINCT');
  });
});
