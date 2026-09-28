import { pool } from '../../../../db/pool.js';

export interface StripeIntegrationEvent {
  integration_event_id: string;
  external_event_id: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string | string[]] =>
    entry[1] !== undefined && entry[0].toLowerCase() !== 'authorization' && entry[0].toLowerCase() !== 'stripe-signature'
  ));
}

export async function enqueueStripeWebhook(input: {
  externalEventId: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ inserted: boolean }> {
  const result = await pool.query(
    `INSERT INTO integration_events (provider, external_event_id, event_type, payload, headers)
     VALUES ('stripe', $1, $2, $3::jsonb, $4::jsonb)
     ON CONFLICT (provider, external_event_id) DO NOTHING`,
    [input.externalEventId, input.eventType, JSON.stringify(input.payload), JSON.stringify(normalizeHeaders(input.headers))]
  );
  return { inserted: Boolean(result.rowCount) };
}

export async function claimStripeWebhookEvents(limit: number): Promise<StripeIntegrationEvent[]> {
  const result = await pool.query<StripeIntegrationEvent>(
    `WITH claimed AS (
       SELECT integration_event_id FROM integration_events
       WHERE provider = 'stripe'
         AND (status IN ('pending', 'retrying') OR (status = 'processing' AND locked_at < now() - interval '10 minutes'))
         AND available_at <= now()
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE integration_events event
     SET status = 'processing', attempt_count = event.attempt_count + 1, locked_at = now(), last_error = null, updated_at = now()
     FROM claimed WHERE event.integration_event_id = claimed.integration_event_id
     RETURNING event.integration_event_id, event.external_event_id, event.event_type, event.payload, event.attempt_count`,
    [limit]
  );
  return result.rows;
}

export async function markStripeWebhookProcessed(eventId: string, bookingId?: string): Promise<void> {
  await pool.query(
    `UPDATE integration_events SET status = 'processed', processed_at = now(), locked_at = null,
       related_booking_id = COALESCE($2::uuid, related_booking_id), last_error = null, updated_at = now()
     WHERE integration_event_id = $1`,
    [eventId, bookingId ?? null]
  );
}

export async function markStripeWebhookRetry(eventId: string, error: string, availableAt: Date): Promise<void> {
  await pool.query(
    `UPDATE integration_events SET status = 'retrying', available_at = $2, locked_at = null,
       last_error = $3, updated_at = now() WHERE integration_event_id = $1`,
    [eventId, availableAt.toISOString(), error.slice(0, 2000)]
  );
}

export async function markStripeWebhookDeadLetter(eventId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE integration_events SET status = 'dead_letter', processed_at = now(), locked_at = null,
       last_error = $2, updated_at = now() WHERE integration_event_id = $1`,
    [eventId, error.slice(0, 2000)]
  );
}
