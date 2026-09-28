import { appConfig } from '../../../../config/env.js';
import { recordAdminErrorEvent } from '../../../../errors/admin-error-events.repository.js';
import { JOB_TYPES } from '../../../../jobs/job-types.js';
import { runJobWithLock } from '../../../../jobs/run-job.js';
import { ProviderSyncConflictError } from '../../../bookings/booking.errors.js';
import { processStripeEvent } from './stripe-webhook.processor.js';
import {
  claimStripeWebhookEvents,
  markStripeWebhookDeadLetter,
  markStripeWebhookProcessed,
  markStripeWebhookRetry
} from './stripe-webhook.repository.js';

function retryAt(attempt: number): Date {
  return new Date(Date.now() + Math.min(15 * 60_000, 5_000 * (2 ** Math.min(attempt, 8))));
}

async function auditFailure(eventId: string, error: string, deadLetter: boolean): Promise<void> {
  try {
    await recordAdminErrorEvent({
      dedupeKey: `stripe-webhook:${eventId}:${deadLetter ? 'dead' : 'retry'}`,
      source: 'stripe',
      severity: deadLetter ? 'critical' : 'warning',
      errorCode: deadLetter ? 'STRIPE_WEBHOOK_FAILED' : 'STRIPE_WEBHOOK_RETRYING',
      diagnosticSummary: error,
      actorType: 'provider',
      actorName: 'Stripe',
      operation: 'process_stripe_webhook',
      entityType: 'integration_event',
      entityId: eventId
    });
  } catch {
    // Inbox state remains authoritative when optional admin error reporting is unavailable.
  }
}

export async function runProcessStripeWebhooksJob(input: { limit?: number } = {}) {
  const limit = input.limit ?? appConfig.STRIPE_WEBHOOK_BATCH_SIZE;
  return runJobWithLock({
    jobType: JOB_TYPES.PROCESS_STRIPE_WEBHOOKS,
    metadata: { limit },
    handler: async () => {
      const events = await claimStripeWebhookEvents(limit);
      let processed = 0;
      let retried = 0;
      let deadLetter = 0;
      for (const event of events) {
        try {
          const result = await processStripeEvent(event.payload);
          await markStripeWebhookProcessed(event.integration_event_id, result.bookingId);
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const permanent = error instanceof ProviderSyncConflictError;
          if (!permanent && event.attempt_count < appConfig.STRIPE_WEBHOOK_MAX_ATTEMPTS) {
            await markStripeWebhookRetry(event.integration_event_id, message, retryAt(event.attempt_count));
            await auditFailure(event.integration_event_id, message, false);
            retried += 1;
          } else {
            await markStripeWebhookDeadLetter(event.integration_event_id, message);
            await auditFailure(event.integration_event_id, message, true);
            deadLetter += 1;
          }
        }
      }
      return { recordsProcessed: processed, metadata: { claimed: events.length, retried, deadLetter } };
    }
  });
}
