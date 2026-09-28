import type { PoolClient } from 'pg';
import { appConfig } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAdminErrorEvent } from '../../errors/admin-error-events.repository.js';
import { JOB_TYPES } from '../../jobs/job-types.js';
import { runJobWithLock } from '../../jobs/run-job.js';

interface OutboxEvent {
  outbox_event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

async function claimOutboxEvents(limit: number): Promise<OutboxEvent[]> {
  const result = await pool.query<OutboxEvent>(
    `WITH claimed AS (
       SELECT outbox_event_id FROM outbox_events
       WHERE (status IN ('pending', 'failed') OR (status = 'processing' AND locked_at < now() - interval '10 minutes'))
         AND available_at <= now() AND attempt_count < $2
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events event SET status = 'processing', attempt_count = event.attempt_count + 1,
       locked_at = now(), last_error = null, updated_at = now()
     FROM claimed WHERE event.outbox_event_id = claimed.outbox_event_id
     RETURNING event.outbox_event_id, event.aggregate_type, event.aggregate_id,
       event.event_type, event.payload, event.attempt_count`,
    [limit, appConfig.OUTBOX_MAX_ATTEMPTS]
  );
  return result.rows;
}

async function grantBookingAccess(client: PoolClient, event: OutboxEvent): Promise<void> {
  await client.query(
    `INSERT INTO access_credentials (
       booking_id, client_id, credential_type, status, valid_from, valid_until, metadata, source_outbox_event_id
     )
     SELECT booking_id, client_id, 'qr', 'active', dt_from, dt_to,
       jsonb_build_object('publicReference', gen_random_uuid()::text, 'source', 'booking.confirmed'), $2
     FROM bookings WHERE booking_id = $1
     ON CONFLICT DO NOTHING`,
    [event.aggregate_id, event.outbox_event_id]
  );
  await client.query(
    `INSERT INTO client_notifications (
       client_id, type, title, body, booking_id, deep_link, data, source_outbox_event_id
     )
     SELECT client_id, 'booking_confirmation', 'Booking confirmed',
       'Your payment was received and your booking is confirmed.', booking_id,
       '/bookings/' || booking_id::text, $3::jsonb, $2
     FROM bookings WHERE booking_id = $1
     ON CONFLICT DO NOTHING`,
    [event.aggregate_id, event.outbox_event_id, JSON.stringify(event.payload)]
  );
}

async function revokeBookingAccess(client: PoolClient, event: OutboxEvent): Promise<void> {
  await client.query(
    `UPDATE access_credentials SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
     WHERE booking_id = $1 AND status NOT IN ('revoked', 'expired')`,
    [event.aggregate_id]
  );
}

async function dispatchOutboxEvent(event: OutboxEvent): Promise<void> {
  await withTransaction(async (client) => {
    if (event.event_type === 'booking.confirmed') await grantBookingAccess(client, event);
    if (event.event_type === 'booking.cancelled') await revokeBookingAccess(client, event);
    await client.query(
      `UPDATE outbox_events SET status = 'published', published_at = now(), locked_at = null,
         last_error = null, updated_at = now() WHERE outbox_event_id = $1`,
      [event.outbox_event_id]
    );
  });
}

async function markOutboxFailed(event: OutboxEvent, error: string): Promise<void> {
  const terminal = event.attempt_count >= appConfig.OUTBOX_MAX_ATTEMPTS;
  const delaySeconds = Math.min(900, 5 * (2 ** Math.min(event.attempt_count, 8)));
  await pool.query(
    `UPDATE outbox_events SET status = 'failed', locked_at = null, last_error = $2,
       available_at = CASE WHEN $3 THEN 'infinity'::timestamptz ELSE now() + ($4::text || ' seconds')::interval END,
       updated_at = now() WHERE outbox_event_id = $1`,
    [event.outbox_event_id, error.slice(0, 2000), terminal, delaySeconds]
  );
  try {
    await recordAdminErrorEvent({
      dedupeKey: `outbox:${event.outbox_event_id}:${terminal ? 'terminal' : event.attempt_count}`,
      source: 'outbox', severity: terminal ? 'critical' : 'warning',
      errorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_DELIVERY_RETRYING',
      diagnosticSummary: error, actorType: 'system', actorName: 'System',
      operation: event.event_type, entityType: event.aggregate_type, entityId: event.aggregate_id,
      bookingId: event.aggregate_type === 'booking' ? event.aggregate_id : undefined
    });
  } catch {
    // Delivery retry state is durable even if optional error reporting fails.
  }
}

export async function runDispatchOutboxEventsJob(input: { limit?: number } = {}) {
  const limit = input.limit ?? appConfig.OUTBOX_BATCH_SIZE;
  return runJobWithLock({
    jobType: JOB_TYPES.DISPATCH_OUTBOX_EVENTS,
    metadata: { limit },
    handler: async () => {
      const events = await claimOutboxEvents(limit);
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await dispatchOutboxEvent(event);
          published += 1;
        } catch (error) {
          await markOutboxFailed(event, error instanceof Error ? error.message : String(error));
          failed += 1;
        }
      }
      return { recordsProcessed: published, metadata: { claimed: events.length, failed } };
    }
  });
}
