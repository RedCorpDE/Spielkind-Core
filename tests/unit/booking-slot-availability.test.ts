import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { getAvailabilitySummary } from '../../src/modules/resources/availability.service.js';
import { listCoreStartSlots } from '../../src/modules/bookings/booking-slot.service.js';
import type { BookingOffering } from '../../src/modules/bookings/booking-intent.js';

vi.mock('../../src/modules/resources/availability.service.js', () => ({
  getAvailabilitySummary: vi.fn()
}));

const offering: BookingOffering = {
  id: '33333333-3333-4333-8333-333333333333',
  locationId: '11111111-1111-4111-8111-111111111111',
  productId: '22222222-2222-4222-8222-222222222222',
  active: true,
  bookingProvider: 'core',
  rules: {
    timeSelectionMode: 'fixed_duration', timezone: 'Europe/Berlin',
    fixedStartTime: null, fixedEndTime: null,
    earliestStartTime: '12:00', latestStartTime: '14:00', startIntervalMinutes: 30,
    minParticipants: 1, maxParticipants: 10,
    minDurationMinutes: 30, maxDurationMinutes: 240, durationStepMinutes: 30,
    defaultDurationMinutes: 30, allowedDurationMinutes: [], minAdvanceMinutes: 0,
    maxAdvanceDays: null, sameDayBookingAllowed: true,
    pricingMode: 'per_quantity', dateRangeBillingUnit: 'nights'
  }
};

const intent = {
  locationId: offering.locationId,
  productId: offering.productId,
  locationProductId: offering.id,
  startAt: '2099-10-02T10:00:00.000Z',
  endAt: '2099-10-02T10:30:00.000Z',
  startDate: '2099-10-02',
  startTime: '12:00',
  participants: 1,
  options: []
};

describe('resolved Core slot availability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('omits every candidate whose complete interval overlaps a busy interval', async () => {
    vi.mocked(getAvailabilitySummary).mockImplementation(async (query) => {
      const start = new Date(query.dt_from).getTime();
      const end = new Date(query.dt_to).getTime();
      const busyStart = new Date('2099-10-02T10:30:00.000Z').getTime();
      const busyEnd = new Date('2099-10-02T11:30:00.000Z').getTime();
      const available = start >= busyEnd || end <= busyStart;
      return {
        available, capacity: 1, reserved: available ? 0 : 1, held: 0,
        remaining: available ? 1 : 0, maxBookableQuantity: available ? 1 : 0,
        resources: []
      };
    });

    const result = await listCoreStartSlots({ intent, offering });
    expect(result.slots.map((slot) => slot.startsAt)).toEqual([
      '2099-10-02T10:00:00.000Z',
      '2099-10-02T11:30:00.000Z',
      '2099-10-02T12:00:00.000Z'
    ]);
  });

  it('does not generate alternative starts for fixed-start offerings', async () => {
    vi.mocked(getAvailabilitySummary).mockResolvedValue({
      available: true, capacity: 1, reserved: 0, held: 0,
      remaining: 1, maxBookableQuantity: 1, resources: []
    });
    const fixedOffering: BookingOffering = {
      ...offering,
      rules: { ...offering.rules, fixedStartTime: '13:00' }
    };
    const result = await listCoreStartSlots({ intent, offering: fixedOffering });
    expect(result.fixedStart).toBe(true);
    expect(result.allowedStart).toBeNull();
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]?.startsAt).toBe('2099-10-02T11:00:00.000Z');
  });
});
