import { pool } from '../db/client.js';

export async function startSync(syncType: string): Promise<string> {
  const result = await pool.query<{ sync_id: string }>(
    `INSERT INTO sync_log (sync_type, status) VALUES ($1, 'started') RETURNING sync_id`,
    [syncType]
  );

  return result.rows[0].sync_id;
}

export async function finishSync(syncId: string, recordsSynced: number): Promise<void> {
  await pool.query(
    `UPDATE sync_log
       SET status = 'completed', records_synced = $2, completed_at = now()
     WHERE sync_id = $1`,
    [syncId, recordsSynced]
  );
}

export async function failSync(syncId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE sync_log
       SET status = 'failed', error_message = $2, completed_at = now()
     WHERE sync_id = $1`,
    [syncId, message]
  );
}
