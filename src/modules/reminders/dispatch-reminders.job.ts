import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import {
  claimReminderDeliveries,
  createDueReminderDeliveries,
  getReminderDeliveryPayload,
  markReminderDeliveryFailed,
  markReminderDeliverySent
} from './reminder.repository.js';
import { sendReminderProviderEvent } from './reminder-provider.client.js';

export async function runDispatchRemindersJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.DISPATCH_REMINDERS,
    metadata: { limit: input.limit ?? 50 },
    handler: async () => {
      const createdCount = await createDueReminderDeliveries(input.limit ?? 250);
      const deliveries = await claimReminderDeliveries(input.limit ?? 50);
      let sentCount = 0;
      let failedCount = 0;

      for (const delivery of deliveries) {
        try {
          const payload = await getReminderDeliveryPayload(delivery.reminder_delivery_id);
          if (!payload) {
            await markReminderDeliveryFailed(delivery.reminder_delivery_id, 'Reminder delivery context not found.');
            failedCount += 1;
            continue;
          }

          const providerResponse = await sendReminderProviderEvent(payload);
          await markReminderDeliverySent(delivery.reminder_delivery_id, providerResponse);
          sentCount += 1;
        } catch (error) {
          await markReminderDeliveryFailed(
            delivery.reminder_delivery_id,
            error instanceof Error ? error.message : String(error)
          );
          failedCount += 1;
        }
      }

      return {
        recordsProcessed: sentCount,
        metadata: {
          createdCount,
          sentCount,
          failedCount,
          claimedCount: deliveries.length
        }
      };
    }
  });
}
