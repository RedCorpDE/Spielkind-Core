import type { PoolClient } from 'pg';

export async function createJobRun(
  client: PoolClient,
  input: { jobType: string; lockKey: string; metadata?: Record<string, unknown> }
): Promise<string> {
  const result = await client.query<{ job_run_id: string }>(
    `INSERT INTO job_runs (job_type, status, lock_key, metadata)
     VALUES ($1, 'running', $2::bigint, $3::jsonb)
     RETURNING job_run_id`,
    [input.jobType, input.lockKey, JSON.stringify(input.metadata ?? {})]
  );

  return result.rows[0].job_run_id;
}

export async function completeJobRun(
  client: PoolClient,
  input: {
    jobRunId: string;
    status: 'success' | 'failed' | 'skipped';
    recordsProcessed: number;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `UPDATE job_runs
     SET status = $2,
         records_processed = $3,
         error_message = $4,
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         completed_at = now()
     WHERE job_run_id = $1`,
    [
      input.jobRunId,
      input.status,
      input.recordsProcessed,
      input.errorMessage ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}
