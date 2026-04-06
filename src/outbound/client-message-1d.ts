import { appConfig } from '../config.js';
import { fetchBookingsInWindow, buildClientMessagePayload } from './payload-builder.js';
import { createJob } from './job-runner.js';

// Window: event starts in exactly 1 day, +/- 30 minutes
const DAYS = 1;
const WINDOW_HALF_MS = 30 * 60 * 1000;

export const clientMessage1dJob = createJob({
  triggerType: 'client_message_1d',
  webhookUrlFn: () => appConfig.RETOOL_WEBHOOK_CLIENT_MESSAGE,
  fetchRows: () => {
    const target = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000);
    const windowStart = new Date(target.getTime() - WINDOW_HALF_MS);
    const windowEnd = new Date(target.getTime() + WINDOW_HALF_MS);
    return fetchBookingsInWindow(windowStart, windowEnd);
  },
  buildPayload: (row) => buildClientMessagePayload(row, 'client_message_1d'),
  scheduledAtFn: (row) => (row.dt_from instanceof Date ? row.dt_from : new Date(row.dt_from)),
});
