import { describe, expect, it, vi } from 'vitest';
import { loadResourceRequirements } from '../../src/modules/resources/resource-requirements.repository.js';

describe('Offering Resource requirement resolution', () => {
  it('multiplies Offering quantities by the requested booking quantity', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        resource_id: 'resource-1', resource_title: 'Gaming PCs', capacity_available: 40,
        required_quantity: '6', source: 'offering'
      }]
    });
    const rows = await loadResourceRequirements({ query } as never, {
      productId: 'product-1', locationId: 'location-1', quantity: 3
    });
    expect(rows[0]).toMatchObject({ required_quantity: 6, source: 'offering' });
    expect(query.mock.calls[0][1]).toEqual(['product-1', 'location-1', 3, true]);
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
    expect(sql).not.toContain('UNION DISTINCT');
  });
});
