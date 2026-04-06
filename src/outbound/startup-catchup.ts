import { appConfig } from '../config.js';
import {
  fetchBookingsInWindow,
  fetchBookingsByCheckOut,
  buildClientMessagePayload,
  buildCheckOutPayload,
  isAlreadySent,
} from './payload-builder.js';
import { sendPayloadDirect } from './job-runner.js';
import type { TriggerType } from './types.js';

interface CatchupResult {
  recovered: number;
  skipped: number;
  failed: number;
}

/**
 * Runs once at server startup. Checks for events that occurred during
 * OUTBOUND_STARTUP_CATCHUP_MINUTES before startup and sends any that were missed.
 * Respects outbound_log idempotency -- already-sent events are skipped.
 * No PII is logged.
 */
export async function runStartupCatchup(): Promise<void> {
  if (!appConfig.OUTBOUND_ENABLED) {
    return;
  }

  const catchupMinutes = appConfig.OUTBOUND_STARTUP_CATCHUP_MINUTES;
  const now = new Date();
  const catchupStart = new Date(now.getTime() - catchupMinutes * 60 * 1000);

  console.log(`[outbound] Startup catchup: checking last ${catchupMinutes} minutes for missed events.`);

  const results = await Promise.allSettled([
    catchupClientMessages('client_message_7d', catchupStart, now),
    catchupClientMessages('client_message_1d', catchupStart, now),
    catchupCheckOuts(catchupStart, now),
  ]);

  let totalRecovered = 0;
  let totalFailed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalRecovered += result.value.recovered;
      totalFailed += result.value.failed;
    } else {
      console.error('[outbound] Startup catchup: one trigger-type check failed:', result.reason);
    }
  }

  console.log(`[outbound] Startup catchup complete: ${totalRecovered} recovered, ${totalFailed} failed.`);
}

async function catchupClientMessages(
  triggerType: 'client_message_7d' | 'client_message_1d',
  catchupStart: Date,
  catchupEnd: Date
): Promise<CatchupResult> {
  const webhookUrl = appConfig.RETOOL_WEBHOOK_CLIENT_MESSAGE;
  if (!webhookUrl) {
    return { recovered: 0, skipped: 0, failed: 0 };
  }

  // For T1 (-7d): events that started ~7 days before catchupStart..catchupEnd
  // For T2 (-1d): events that started ~1 day before catchupStart..catchupEnd
  const offsetDays: Record<TriggerType, number> = {
    client_message_7d: 7,
    client_message_1d: 1,
    check_out: 0,
  };

  const offsetMs = offsetDays[triggerType] * 24 * 60 * 60 * 1000;
  const eventWindowStart = new Date(catchupStart.getTime() + offsetMs);
  const eventWindowEnd = new Date(catchupEnd.getTime() + offsetMs);

  const rows = await fetchBookingsInWindow(eventWindowStart, eventWindowEnd);

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const alreadySent = await isAlreadySent(row.booking_id, triggerType);
    if (alreadySent) {
      skipped++;
      continue;
    }

    const payload = buildClientMessagePayload(row, triggerType);
    const scheduledAt = row.dt_from instanceof Date ? row.dt_from : new Date(row.dt_from);
    const success = await sendPayloadDirect(triggerType, webhookUrl, payload, row.booking_id, scheduledAt);

    if (success) {
      recovered++;
    } else {
      failed++;
    }
  }

  return { recovered, skipped, failed };
}

async function catchupCheckOuts(catchupStart: Date, catchupEnd: Date): Promise<CatchupResult> {
  const webhookUrl = appConfig.RETOOL_WEBHOOK_CHECK_OUT;
  if (!webhookUrl) {
    return { recovered: 0, skipped: 0, failed: 0 };
  }

  const rows = await fetchBookingsByCheckOut(catchupStart, catchupEnd);

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const alreadySent = await isAlreadySent(row.booking_id, 'check_out');
    if (alreadySent) {
      skipped++;
      continue;
    }

    const payload = buildCheckOutPayload(row);
    const scheduledAt = row.dt_to instanceof Date ? row.dt_to : new Date(row.dt_to);
    const success = await sendPayloadDirect('check_out', webhookUrl, payload, row.booking_id, scheduledAt);

    if (success) {
      recovered++;
    } else {
      failed++;
    }
  }

  return { recovered, skipped, failed };
}
