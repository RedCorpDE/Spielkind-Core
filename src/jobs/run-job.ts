import { logger } from '../config/logger.js';
import { advisoryLockKey, withSessionAdvisoryLock } from '../db/locks.js';
import { completeJobRun, createJobRun } from './job-run.repository.js';
import type { JobResult, JobType } from './job-types.js';

interface RunJobOptions {
  jobType: JobType;
  metadata?: Record<string, unknown>;
  handler: (context: { jobRunId: string }) => Promise<{ recordsProcessed: number; metadata?: Record<string, unknown> }>;
}

export async function runJobWithLock(options: RunJobOptions): Promise<JobResult> {
  const startedAt = new Date();
  const lockKey = advisoryLockKey(`job:${options.jobType}`);
  const lockOutcome = await withSessionAdvisoryLock(lockKey, async (client) => {
    const jobRunId = await createJobRun(client, {
      jobType: options.jobType,
      lockKey,
      metadata: options.metadata
    });

    try {
      const result = await options.handler({ jobRunId });
      await completeJobRun(client, {
        jobRunId,
        status: 'success',
        recordsProcessed: result.recordsProcessed,
        metadata: result.metadata
      });

      return result;
    } catch (error) {
      await completeJobRun(client, {
        jobRunId,
        status: 'failed',
        recordsProcessed: 0,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });

  if (!lockOutcome.acquired) {
    const completedAt = new Date();
    return {
      jobType: options.jobType,
      status: 'skipped',
      recordsProcessed: 0,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      metadata: { reason: 'lock_not_acquired' }
    };
  }

  const completedAt = new Date();
  logger.info(
    {
      jobType: options.jobType,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      recordsProcessed: lockOutcome.result.recordsProcessed
    },
    'Job finished'
  );

  return {
    jobType: options.jobType,
    status: 'success',
    recordsProcessed: lockOutcome.result.recordsProcessed,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    metadata: lockOutcome.result.metadata
  };
}
