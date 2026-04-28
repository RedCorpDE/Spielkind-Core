import { appConfig } from '../config.js';
import { processPendingBookingWebhookEvents } from './sync-service.js';

let workerRunning = false;
let inboxTableMissingWarningShown = false;

function isMissingRegiondoWebhookEventsTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeDatabaseError = error as { code?: string; message?: string };
  return (
    maybeDatabaseError.code === '42P01' &&
    typeof maybeDatabaseError.message === 'string' &&
    maybeDatabaseError.message.includes('regiondo_webhook_events')
  );
}

async function runWorkerPass(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  try {
    const processed = await processPendingBookingWebhookEvents(appConfig.REGIONDO_WEBHOOK_WORKER_BATCH_SIZE);
    if (processed > 0) {
      console.log(`[regiondo-webhook-worker] Processed ${processed} queued booking webhook event(s).`);
    }
    if (inboxTableMissingWarningShown) {
      console.log('[regiondo-webhook-worker] Regiondo webhook inbox table is now available again.');
      inboxTableMissingWarningShown = false;
    }
  } catch (error) {
    if (isMissingRegiondoWebhookEventsTable(error)) {
      if (!inboxTableMissingWarningShown) {
        console.warn(
          '[regiondo-webhook-worker] regiondo_webhook_events does not exist yet. Run `npm run migrate` to apply 025_regiondo_booking_inbox.sql.'
        );
        inboxTableMissingWarningShown = true;
      }
      return;
    }

    console.error('[regiondo-webhook-worker] Processing failed:', error);
  } finally {
    workerRunning = false;
  }
}

export function triggerRegiondoWebhookWorker(): void {
  void runWorkerPass();
}

export function startRegiondoWebhookWorker(): void {
  const timer = setInterval(() => {
    void runWorkerPass();
  }, appConfig.REGIONDO_WEBHOOK_WORKER_INTERVAL_MS);

  timer.unref?.();
  console.log(
    `[regiondo-webhook-worker] Polling every ${appConfig.REGIONDO_WEBHOOK_WORKER_INTERVAL_MS}ms with batch size ${appConfig.REGIONDO_WEBHOOK_WORKER_BATCH_SIZE}.`
  );

  void runWorkerPass();
}
