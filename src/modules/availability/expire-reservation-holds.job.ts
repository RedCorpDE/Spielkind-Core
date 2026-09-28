import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { expireReservationHolds } from './reservation-hold.service.js';

export async function runExpireReservationHoldsJob(input: { limit?: number } = {}) {
  const limit = input.limit ?? 500;
  return runJobWithLock({
    jobType: JOB_TYPES.EXPIRE_RESERVATION_HOLDS,
    metadata: { limit },
    handler: async () => ({ recordsProcessed: await expireReservationHolds(limit) })
  });
}

