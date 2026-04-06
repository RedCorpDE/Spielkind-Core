import { appConfig } from '../config.js';
import { fetchBookingsByCheckOut, buildCheckOutPayload } from './payload-builder.js';
import { createJob } from './job-runner.js';

// Window: check-out (dt_to) is now, +/- 30 minutes
const WINDOW_HALF_MS = 30 * 60 * 1000;

export const checkOutJob = createJob({
  triggerType: 'check_out',
  webhookUrlFn: () => appConfig.RETOOL_WEBHOOK_CHECK_OUT,
  fetchRows: () => {
    const now = Date.now();
    const windowStart = new Date(now - WINDOW_HALF_MS);
    const windowEnd = new Date(now + WINDOW_HALF_MS);
    return fetchBookingsByCheckOut(windowStart, windowEnd);
  },
  buildPayload: (row) => buildCheckOutPayload(row),
  // scheduledAt for check-out is dt_to (end of booking)
  scheduledAtFn: (row) => (row.dt_to instanceof Date ? row.dt_to : new Date(row.dt_to)),
});
