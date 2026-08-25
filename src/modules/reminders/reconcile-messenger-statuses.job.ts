import { reconcileWhatsAppReminderStatuses } from './reminder.repository.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { JOB_TYPES } from '../../jobs/job-types.js';

export async function runReconcileMessengerStatusesJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.RECONCILE_MESSENGER_STATUSES,
    metadata: { limit: input.limit ?? 100 },
    handler: async () => {
      const recordsProcessed = await reconcileWhatsAppReminderStatuses(input.limit ?? 100);
      return { recordsProcessed };
    }
  });
}
