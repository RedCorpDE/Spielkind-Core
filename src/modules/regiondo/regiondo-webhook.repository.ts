import { pool } from '../../db/pool.js';

export interface RegiondoWebhookEventRecord {
  event_id: string;
  booking_key: string;
  order_number: string | null;
  action_type: string | null;
  channel: string | null;
  provider_snapshot_at: string | null;
  payload: unknown;
  headers: unknown;
  attempt_count: number;
}

function normalizeHeaderMap(headers: Record<string, string | string[] | undefined>) {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    normalized[key] = Array.isArray(value) ? value : `${value}`;
  }

  return normalized;
}

export async function enqueueRegiondoWebhookEvents(input: {
  payload: unknown;
  bookingKeys: string[];
  dedupeKeyByBookingKey: Map<string, string>;
  orderNumber: string | null;
  actionType: string | null;
  channel: string | null;
  providerSnapshotAt: string | null;
  headers: Record<string, string | string[] | undefined>;
}): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    let insertedCount = 0;
    const headers = normalizeHeaderMap(input.headers);

    for (const bookingKey of input.bookingKeys) {
      const dedupeKey = input.dedupeKeyByBookingKey.get(bookingKey);
      if (!dedupeKey) {
        continue;
      }

      const result = await client.query(
        `INSERT INTO regiondo_webhook_events (
           booking_key,
           order_number,
           action_type,
           channel,
           dedupe_key,
           provider_snapshot_at,
           payload,
           headers
         )
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          bookingKey,
          input.orderNumber,
          input.actionType,
          input.channel,
          dedupeKey,
          input.providerSnapshotAt,
          JSON.stringify(input.payload),
          JSON.stringify(headers)
        ]
      );

      insertedCount += result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return insertedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimRegiondoWebhookEvents(limit: number): Promise<RegiondoWebhookEventRecord[]> {
  const result = await pool.query<RegiondoWebhookEventRecord>(
    `WITH next_events AS (
       SELECT event_id
       FROM regiondo_webhook_events
       WHERE status IN ('pending', 'retrying')
         AND available_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE regiondo_webhook_events AS events
     SET status = 'processing',
         attempt_count = events.attempt_count + 1,
         locked_at = now(),
         last_error = null
     FROM next_events
     WHERE events.event_id = next_events.event_id
     RETURNING
       events.event_id,
       events.booking_key,
       events.order_number,
       events.action_type,
       events.channel,
       events.provider_snapshot_at,
       events.payload,
       events.headers,
       events.attempt_count`,
    [limit]
  );

  return result.rows;
}

export async function markRegiondoWebhookEventProcessed(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'processed',
         processed_at = now(),
         locked_at = null,
         last_error = null
     WHERE event_id = $1`,
    [eventId]
  );
}

export async function markRegiondoWebhookEventRetry(eventId: string, errorMessage: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'retrying',
         available_at = $2::timestamptz,
         locked_at = null,
         last_error = $3
     WHERE event_id = $1`,
    [eventId, nextAttemptAt.toISOString(), errorMessage]
  );
}

export async function markRegiondoWebhookEventDeadLetter(eventId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE regiondo_webhook_events
     SET status = 'dead_letter',
         processed_at = now(),
         locked_at = null,
         last_error = $2
     WHERE event_id = $1`,
    [eventId, errorMessage]
  );
}
