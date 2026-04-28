import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './pool.js';

export function advisoryLockKey(input: string): string {
  const digest = createHash('sha256').update(input).digest();
  return digest.readBigInt64BE(0).toString();
}

export async function withSessionAdvisoryLock<T>(
  lockKey: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const client = await pool.connect();

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [lockKey]
    );

    if (!lockResult.rows[0]?.acquired) {
      return { acquired: false };
    }

    try {
      const result = await fn(client);
      return { acquired: true, result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
    }
  } finally {
    client.release();
  }
}
