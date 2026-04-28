import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { regiondoClient } from '../regiondo/regiondo.client.js';
import { importNormalizedRegiondoBooking, listRegiondoBookingsForReconciliation } from './booking.repository.js';
import { normalizeRegiondoBookingImport } from './booking-normalizer.js';
import { rebuildConsumptionsForBooking } from '../resources/consumption.service.js';

export async function runReconcileRegiondoBookingsJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.RECONCILE_REGIONDO_BOOKINGS,
    metadata: { limit: input.limit ?? 50 },
    handler: async () => {
      const candidates = await listRegiondoBookingsForReconciliation(input.limit ?? 50);
      let processedCount = 0;

      for (const candidate of candidates) {
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
        await rebuildConsumptionsForBooking(bookingId);
        processedCount += 1;
      }

      return {
        recordsProcessed: processedCount,
        metadata: {
          candidateCount: candidates.length
        }
      };
    }
  });
}
