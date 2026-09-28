import { describe, expect, it } from 'vitest';
import { isReservationHoldCapacityActive } from '../../src/modules/availability/reservation-hold.service.js';

describe('reservation hold lease', () => {
  it('only counts active, non-expired holds', () => {
    const now = '2026-09-28T10:00:00.000Z';
    expect(isReservationHoldCapacityActive('active', '2026-09-28T10:01:00.000Z', now)).toBe(true);
    expect(isReservationHoldCapacityActive('active', '2026-09-28T09:59:00.000Z', now)).toBe(false);
    expect(isReservationHoldCapacityActive('released', '2026-09-28T10:01:00.000Z', now)).toBe(false);
    expect(isReservationHoldCapacityActive('consumed', '2026-09-28T10:01:00.000Z', now)).toBe(false);
  });
});

