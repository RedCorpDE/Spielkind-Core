import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { pool } from '../../db/pool.js';

const REGIONDO_BOOKING_SYNC_TYPE = 'regiondo_bookings';

async function upsertRegiondoBookingSyncState(
  client: PoolClient,
  input: {
    cursorValue: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO sync_state (sync_type, cursor_value, last_success_at, last_attempt_at, metadata)
     VALUES ($1, $2, now(), now(), $3::jsonb)
     ON CONFLICT (sync_type)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value,
                   last_success_at = EXCLUDED.last_success_at,
                   last_attempt_at = EXCLUDED.last_attempt_at,
                   metadata = EXCLUDED.metadata,
                   updated_at = now()`,
    [REGIONDO_BOOKING_SYNC_TYPE, input.cursorValue, JSON.stringify(input.metadata ?? {})]
  );
}

export async function getRegiondoBookingSyncCursorValue(): Promise<string | null> {
  const result = await pool.query<{ cursor_value: string | null }>(
    `SELECT cursor_value
     FROM sync_state
     WHERE sync_type = $1
     LIMIT 1`,
    [REGIONDO_BOOKING_SYNC_TYPE]
  );

  return result.rowCount ? result.rows[0].cursor_value : null;
}

export async function storeRegiondoBookingSyncState(input: {
  cursorValue: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withTransaction(async (client) => {
    await upsertRegiondoBookingSyncState(client, input);
  });
}
