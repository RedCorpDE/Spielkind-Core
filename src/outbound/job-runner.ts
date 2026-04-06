import { appConfig } from '../config.js';
import { isAlreadySent, upsertOutboundLog } from './payload-builder.js';
import type { OutboundPayload, TriggerType } from './types.js';

const MAX_ATTEMPTS = 3;
// Exponential backoff base in ms (1s, 2s, 4s)
const BACKOFF_BASE_MS = 1000;

/**
 * Sends a single payload to the given webhook URL with exponential backoff.
 * Returns true on success, false after all attempts are exhausted.
 * Never throws -- all errors are caught and logged without PII.
 */
async function sendWithRetry(
  webhookUrl: string,
  payload: OutboundPayload,
  bookingId: string,
  triggerType: TriggerType,
  scheduledAt: Date
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        await upsertOutboundLog(
          bookingId,
          triggerType,
          scheduledAt,
          'sent',
          attempt,
          null,
          new Date()
        );
        console.log(`[outbound] Sent ${triggerType} for booking ${bookingId} (attempt ${attempt}).`);
        return true;
      }

      const errorText = `HTTP ${response.status} ${response.statusText}`;
      console.error(`[outbound] ${triggerType} attempt ${attempt}/${MAX_ATTEMPTS} failed for booking ${bookingId}: ${errorText}`);

      await upsertOutboundLog(
        bookingId,
        triggerType,
        scheduledAt,
        attempt === MAX_ATTEMPTS ? 'failed' : 'pending',
        attempt,
        errorText,
        null
      );
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error(`[outbound] ${triggerType} attempt ${attempt}/${MAX_ATTEMPTS} error for booking ${bookingId}: ${errorText}`);

      await upsertOutboundLog(
        bookingId,
        triggerType,
        scheduledAt,
        attempt === MAX_ATTEMPTS ? 'failed' : 'pending',
        attempt,
        errorText,
        null
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type JobFn = () => Promise<void>;

/**
 * Creates a job function that:
 * 1. Guards against concurrent execution (isRunning lock)
 * 2. Resolves the webhook URL from config (skips job if not configured)
 * 3. For each booking row: checks idempotency, builds payload, sends via webhook
 *
 * The caller provides fetchRows (DB query) and buildPayload (row -> payload).
 */
export function createJob<TRow extends { booking_id: string; dt_from: Date | string }>(options: {
  triggerType: TriggerType;
  webhookUrlFn: () => string | undefined;
  fetchRows: () => Promise<TRow[]>;
  buildPayload: (row: TRow) => OutboundPayload;
  scheduledAtFn: (row: TRow) => Date;
}): JobFn {
  let isRunning = false;

  return async function runJob(): Promise<void> {
    if (isRunning) {
      console.log(`[outbound] ${options.triggerType} job skipped — previous run still in progress.`);
      return;
    }

    isRunning = true;
    try {
      const webhookUrl = options.webhookUrlFn();
      if (!webhookUrl) {
        console.log(`[outbound] ${options.triggerType} skipped — webhook URL not configured.`);
        return;
      }

      const rows = await options.fetchRows();
      if (rows.length === 0) {
        return;
      }

      console.log(`[outbound] ${options.triggerType}: ${rows.length} booking(s) in window.`);

      for (const row of rows) {
        const alreadySent = await isAlreadySent(row.booking_id, options.triggerType);
        if (alreadySent) {
          continue;
        }

        const payload = options.buildPayload(row);
        const scheduledAt = options.scheduledAtFn(row);
        await sendWithRetry(webhookUrl, payload, row.booking_id, options.triggerType, scheduledAt);
      }
    } catch (err) {
      // Top-level catch: unexpected errors (e.g. DB unreachable) must not crash the process
      console.error(`[outbound] ${options.triggerType} job encountered unexpected error:`, err);
    } finally {
      isRunning = false;
    }
  };
}

/**
 * Sends a pre-built payload directly, bypassing the job runner's fetch/build cycle.
 * Used by startup-catchup for individual recovered events.
 */
export async function sendPayloadDirect(
  triggerType: TriggerType,
  webhookUrl: string,
  payload: OutboundPayload,
  bookingId: string,
  scheduledAt: Date
): Promise<boolean> {
  return sendWithRetry(webhookUrl, payload, bookingId, triggerType, scheduledAt);
}
