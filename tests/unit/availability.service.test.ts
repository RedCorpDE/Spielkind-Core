import { describe, expect, it } from 'vitest';
import { calculateAvailabilitySnapshot } from '../../src/modules/resources/availability.service.js';

describe('calculateAvailabilitySnapshot', () => {
  it('reports availability when remaining capacity covers the requirement', () => {
    expect(
      calculateAvailabilitySnapshot({
        requiredQuantity: 2,
        capacityAvailable: 6,
        capacityReserved: 3
      })
    ).toEqual({
      required_quantity: 2,
      capacity_available: 6,
      capacity_reserved: 3,
      capacity_remaining: 3,
      is_available: true
    });
  });

  it('reports overbooking when remaining capacity is insufficient', () => {
    expect(
      calculateAvailabilitySnapshot({
        requiredQuantity: 4,
        capacityAvailable: 5,
        capacityReserved: 3
      })
    ).toEqual({
      required_quantity: 4,
      capacity_available: 5,
      capacity_reserved: 3,
      capacity_remaining: 2,
      is_available: false
    });
  });
});
