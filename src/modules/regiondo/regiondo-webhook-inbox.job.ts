import { appConfig } from '../../config/env.js';
import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';
import { startSync, finishSync, failSync } from '../../sync/sync-log.js';
import { importNormalizedRegiondoBooking } from '../bookings/booking.repository.js';
import { normalizeRegiondoBookingImport } from '../bookings/booking-normalizer.js';
import { rebuildConsumptionsForBooking } from '../resources/consumption.service.js';
import { isRetryableRegiondoError, regiondoClient } from './regiondo.client.js';
import {
  claimRegiondoWebhookEvents,
  markRegiondoWebhookEventDeadLetter,
  markRegiondoWebhookEventProcessed,
  markRegiondoWebhookEventRetry
} from './regiondo-webhook.repository.js';
import { regiondoWebhookPayloadSchema } from './regiondo.types.js';

function nextAttemptAt(attemptCount: number): Date {
  const delayMs = Math.min(5 * 60 * 1000, 10_000 * Math.max(1, attemptCount));
  return new Date(Date.now() + delayMs);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runProcessRegiondoWebhookInboxJob(input: { limit?: number } = {}) {
  return runJobWithLock({
    jobType: JOB_TYPES.PROCESS_REGIONDO_WEBHOOKS,
    metadata: { limit: input.limit ?? appConfig.REGIONDO_WEBHOOK_BATCH_SIZE },
    handler: async () => {
      const syncId = await startSync('regiondo_webhook_inbox');
      const events = await claimRegiondoWebhookEvents(input.limit ?? appConfig.REGIONDO_WEBHOOK_BATCH_SIZE);
      let processedCount = 0;
      let retriedCount = 0;
      let deadLetterCount = 0;

      try {
        for (const event of events) {
          try {
            const payload = regiondoWebhookPayloadSchema.parse(event.payload);
            const snapshot = await regiondoClient.hydrateBookingOrder({
              bookingKey: event.booking_key,
              orderNumber: event.order_number
            });

            const normalized = normalizeRegiondoBookingImport({
              bookingKey: event.booking_key,
              purchaseData: snapshot.purchaseData,
              supplierBookings: snapshot.supplierBookings,
              webhookPayload: payload
            });

            const { bookingId } = await importNormalizedRegiondoBooking(normalized);
            await rebuildConsumptionsForBooking(bookingId);
            await markRegiondoWebhookEventProcessed(event.event_id);
            processedCount += 1;
          } catch (error) {
            const message = toErrorMessage(error);

            if (isRetryableRegiondoError(error) && event.attempt_count < appConfig.REGIONDO_WEBHOOK_MAX_ATTEMPTS) {
              await markRegiondoWebhookEventRetry(event.event_id, message, nextAttemptAt(event.attempt_count));
              retriedCount += 1;
              continue;
            }

            await markRegiondoWebhookEventDeadLetter(event.event_id, message);
            deadLetterCount += 1;
          }
        }

        await finishSync(syncId, processedCount);
        return {
          recordsProcessed: processedCount,
          metadata: {
            claimed: events.length,
            retriedCount,
            deadLetterCount
          }
        };
      } catch (error) {
        await failSync(syncId, error);
        throw error;
      }
    }
  });
}
