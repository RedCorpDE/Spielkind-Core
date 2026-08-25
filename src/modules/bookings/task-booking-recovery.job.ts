import { recoverPendingTaskBookingAttempts } from '../../dashboard/repository/bookings.js';
import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';

export async function runRecoverTaskBookingAttemptsJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.RECOVER_TASK_BOOKING_ATTEMPTS,
    metadata: { limit: input.limit ?? 50 },
    handler: async () => {
      const result = await recoverPendingTaskBookingAttempts(input.limit ?? 50);
      return { recordsProcessed: result.completedCount, metadata: result };
    }
  });
}
