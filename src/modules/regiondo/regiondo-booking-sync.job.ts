import { appConfig } from '../../config/env.js';
import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { finishSync, startSync, failSync } from '../../sync/sync-log.js';
import { importNormalizedRegiondoBooking } from '../bookings/booking.repository.js';
import { normalizeRegiondoBookingImport } from '../bookings/booking-normalizer.js';
import { isNonBlockingConsumptionRebuildError, rebuildConsumptionsForBooking } from '../resources/consumption.service.js';
import { regiondoClient } from './regiondo.client.js';
import {
  buildRegiondoBookingSyncWindow,
  collectRegiondoBookingSyncCandidates
} from './regiondo-booking-sync.service.js';
import {
  getRegiondoBookingSyncCursorValue,
  storeRegiondoBookingSyncState
} from './regiondo-booking-sync.repository.js';

const REGIONDO_BOOKING_SYNC_PAGE_SIZE = 250;

async function fetchSupplierBookingsForWindow(input: {
  endDate: string;
  startDate: string;
}): Promise<{ bookingsCount: number; pageCount: number; supplierBookings: Awaited<ReturnType<typeof regiondoClient.listSupplierBookings>> }> {
  const supplierBookings: Awaited<ReturnType<typeof regiondoClient.listSupplierBookings>> = [];
  let offset = 0;
  let pageCount = 0;

  while (true) {
    const page = await regiondoClient.listSupplierBookings({
      dateRange: `${input.startDate},${input.endDate}`,
      dateRangeBy: 'date_bought',
      limit: REGIONDO_BOOKING_SYNC_PAGE_SIZE,
      offset,
      type: 'booking'
    });

    supplierBookings.push(...page);
    pageCount += 1;

    if (page.length < REGIONDO_BOOKING_SYNC_PAGE_SIZE) {
      break;
    }

    offset += REGIONDO_BOOKING_SYNC_PAGE_SIZE;
  }

  return {
    bookingsCount: supplierBookings.length,
    pageCount,
    supplierBookings
  };
}

export async function runSyncRegiondoBookingsJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.SYNC_REGIONDO_BOOKINGS,
    metadata: { limit: input.limit ?? null },
    handler: async () => {
      const syncId = await startSync('regiondo_bookings');

      try {
        const previousCursorValue = await getRegiondoBookingSyncCursorValue();
        const window = buildRegiondoBookingSyncWindow({
          initialLookbackDays: appConfig.REGIONDO_BOOKING_SYNC_INITIAL_LOOKBACK_DAYS,
          lastSuccessAt: previousCursorValue,
          overlapDays: appConfig.REGIONDO_BOOKING_SYNC_OVERLAP_DAYS
        });
        const { bookingsCount, pageCount, supplierBookings } = await fetchSupplierBookingsForWindow(window);
        const allCandidates = collectRegiondoBookingSyncCandidates(supplierBookings);
        const candidates =
          typeof input.limit === 'number' && input.limit > 0
            ? allCandidates.slice(0, input.limit)
            : allCandidates;
        const isTruncated =
          typeof input.limit === 'number' && input.limit > 0 && allCandidates.length > input.limit;
        const failures: string[] = [];
        let processedCount = 0;
        let skippedConsumptionRebuildCount = 0;

        for (const candidate of candidates) {
          try {
            const snapshot = await regiondoClient.hydrateBookingOrder({
              bookingKey: candidate.bookingKey,
              orderNumber: candidate.orderNumber
            });
            const normalized = normalizeRegiondoBookingImport({
              bookingKey: candidate.bookingKey,
              purchaseData: snapshot.purchaseData,
              supplierBookings: snapshot.supplierBookings,
              webhookPayload: null
            });
            const { bookingId } = await importNormalizedRegiondoBooking(normalized);

            try {
              await rebuildConsumptionsForBooking(bookingId);
            } catch (error) {
              if (!isNonBlockingConsumptionRebuildError(error)) {
                throw error;
              }

              skippedConsumptionRebuildCount += 1;
            }

            processedCount += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${candidate.bookingKey}: ${message}`);
          }
        }

        if (failures.length > 0) {
          throw new Error(
            `Regiondo booking sync processed ${processedCount} booking(s), but ${failures.length} failed. First failure: ${failures[0]}`
          );
        }

        const metadata = {
          candidateCount: candidates.length,
          cursorAdvanced: !isTruncated,
          importedCount: processedCount,
          pageCount,
          skippedConsumptionRebuildCount,
          supplierBookingRowCount: bookingsCount,
          windowEndDate: window.endDate,
          windowStartDate: window.startDate
        };

        if (!isTruncated) {
          await storeRegiondoBookingSyncState({
            cursorValue: window.cursorValue,
            metadata
          });
        }

        await finishSync(syncId, processedCount);
        return {
          recordsProcessed: processedCount,
          metadata
        };
      } catch (error) {
        await failSync(syncId, error);
        throw error;
      }
    }
  });
}
