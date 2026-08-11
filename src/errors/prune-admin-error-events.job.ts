import { pruneAdminErrorEvents } from './admin-error-events.repository.js';
import { runJobWithLock } from '../jobs/run-job.js';
import { JOB_TYPES } from '../jobs/job-types.js';

export async function runPruneAdminErrorEventsJob() {
  return runJobWithLock({
    jobType: JOB_TYPES.PRUNE_ADMIN_ERRORS,
    handler: async () => ({ recordsProcessed: await pruneAdminErrorEvents(90) })
  });
}
