export const JOB_TYPES = {
  PROCESS_REGIONDO_WEBHOOKS: 'process_regiondo_webhooks',
  SYNC_REGIONDO_BOOKINGS: 'sync_regiondo_bookings',
  SYNC_REGIONDO_CATALOG: 'sync_regiondo_catalog',
  DISPATCH_REMINDERS: 'dispatch_reminders',
  RECONCILE_MESSENGER_STATUSES: 'reconcile_messenger_statuses',
  RECONCILE_REGIONDO_BOOKINGS: 'reconcile_regiondo_bookings',
  RECOVER_TASK_BOOKING_ATTEMPTS: 'recover_task_booking_attempts',
  PRUNE_ADMIN_ERRORS: 'prune_admin_errors',
  EXPIRE_RESERVATION_HOLDS: 'expire_reservation_holds',
  PROCESS_STRIPE_WEBHOOKS: 'process_stripe_webhooks',
  DISPATCH_OUTBOX_EVENTS: 'dispatch_outbox_events'
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface JobResult {
  jobType: JobType;
  status: 'success' | 'failed' | 'skipped';
  recordsProcessed: number;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}
