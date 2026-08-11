import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  failSync: vi.fn(),
  finishSync: vi.fn(),
  getCursor: vi.fn(),
  hydrateBookingOrder: vi.fn(),
  importBooking: vi.fn(),
  listSupplierBookings: vi.fn(),
  normalizeBooking: vi.fn(),
  rebuildConsumptions: vi.fn(),
  startSync: vi.fn(),
  storeSyncState: vi.fn()
}));

vi.mock('../../src/jobs/run-job.js', () => ({
  runJobWithLock: vi.fn(async (options: { handler: () => Promise<unknown> }) => options.handler())
}));

vi.mock('../../src/sync/sync-log.js', () => ({
  failSync: mocks.failSync,
  finishSync: mocks.finishSync,
  startSync: mocks.startSync
}));

vi.mock('../../src/modules/regiondo/regiondo.client.js', () => ({
  regiondoClient: {
    hydrateBookingOrder: mocks.hydrateBookingOrder,
    listSupplierBookings: mocks.listSupplierBookings
  }
}));

vi.mock('../../src/modules/bookings/booking.repository.js', () => ({
  importNormalizedRegiondoBooking: mocks.importBooking
}));

vi.mock('../../src/modules/bookings/booking-normalizer.js', () => ({
  normalizeRegiondoBookingImport: mocks.normalizeBooking
}));

vi.mock('../../src/modules/resources/consumption.service.js', () => ({
  isNonBlockingConsumptionRebuildError: vi.fn(() => false),
  rebuildConsumptionsForBooking: mocks.rebuildConsumptions
}));

vi.mock('../../src/modules/regiondo/regiondo-booking-sync.repository.js', () => ({
  getRegiondoBookingSyncCursorValue: mocks.getCursor,
  storeRegiondoBookingSyncState: mocks.storeSyncState
}));

import { runSyncRegiondoBookingsJob } from '../../src/modules/regiondo/regiondo-booking-sync.job.js';

describe('targeted Regiondo booking sync', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.startSync.mockResolvedValue('sync-1');
    mocks.hydrateBookingOrder.mockResolvedValue({ purchaseData: {}, supplierBookings: [] });
    mocks.normalizeBooking.mockReturnValue({ bookingKey: 'booking-key-1' });
    mocks.importBooking.mockResolvedValue({ bookingId: '11111111-1111-1111-1111-111111111111' });
    mocks.rebuildConsumptions.mockResolvedValue(undefined);
  });

  it('imports exactly the requested booking without listing history or advancing the cursor', async () => {
    const result = await runSyncRegiondoBookingsJob({ bookingKey: ' booking-key-1 ' });

    expect(mocks.hydrateBookingOrder).toHaveBeenCalledOnce();
    expect(mocks.hydrateBookingOrder).toHaveBeenCalledWith({
      bookingKey: 'booking-key-1',
      orderNumber: null
    });
    expect(mocks.listSupplierBookings).not.toHaveBeenCalled();
    expect(mocks.getCursor).not.toHaveBeenCalled();
    expect(mocks.storeSyncState).not.toHaveBeenCalled();
    expect(mocks.importBooking).toHaveBeenCalledOnce();
    expect(mocks.finishSync).toHaveBeenCalledWith('sync-1', 1);
    expect(result).toMatchObject({
      recordsProcessed: 1,
      metadata: {
        candidateCount: 1,
        cursorAdvanced: false,
        importedCount: 1,
        targetedBookingKey: 'booking-key-1'
      }
    });
  });
});
