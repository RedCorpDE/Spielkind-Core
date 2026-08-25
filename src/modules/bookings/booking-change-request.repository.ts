import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type BookingChangeRequestStatus = 'pending' | 'completed' | 'rejected' | 'conflict' | 'cancelled';
export type BookingChangeSet = Record<string, { from: unknown; to: unknown }>;

export interface BookingChangeRequestSummary {
  id: string;
  status: BookingChangeRequestStatus;
  changes: BookingChangeSet;
  providerKey: string;
  requestedAt: string;
  requestedBy: string;
  resolution: Record<string, unknown> | null;
}

function asChanges(value: unknown): BookingChangeSet {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as BookingChangeSet : {};
}

export async function createOrMergeBookingChangeRequest(input: {
  client: PoolClient;
  bookingId: string;
  changes: BookingChangeSet;
  providerKey: string;
  requestedBy: string;
}): Promise<void> {
  const existing = await input.client.query<{ change_request_id: string; changes: unknown }>(
    `SELECT change_request_id, changes
     FROM booking_change_requests
     WHERE booking_id = $1 AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1
     FOR UPDATE`,
    [input.bookingId]
  );
  if (existing.rowCount) {
    const existingChanges = asChanges(existing.rows[0].changes);
    const overlappingFields = Object.keys(input.changes).filter((field) => field in existingChanges);
    if (overlappingFields.length) {
      await input.client.query(
        `INSERT INTO booking_change_requests (
           change_request_id, booking_id, provider_key, requested_by, changes, status, completed_at, resolution
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'conflict', now(), $6::jsonb)`,
        [
          randomUUID(),
          input.bookingId,
          input.providerKey,
          input.requestedBy,
          JSON.stringify(input.changes),
          JSON.stringify({
            reason: 'overlapping_pending_request',
            conflictingChangeRequestId: existing.rows[0].change_request_id,
            overlappingFields
          })
        ]
      );
      return;
    }
    const merged = { ...existingChanges, ...input.changes };
    await input.client.query(
      `UPDATE booking_change_requests
       SET changes = $2::jsonb, requested_at = now(), requested_by = $3
       WHERE change_request_id = $1`,
      [existing.rows[0].change_request_id, JSON.stringify(merged), input.requestedBy]
    );
    return;
  }
  await input.client.query(
    `INSERT INTO booking_change_requests (change_request_id, booking_id, provider_key, requested_by, changes)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), input.bookingId, input.providerKey, input.requestedBy, JSON.stringify(input.changes)]
  );
}

export async function resolveBookingChangeRequests(input: {
  client: PoolClient;
  bookingId: string;
  providerValues: Record<string, unknown>;
}): Promise<void> {
  const result = await input.client.query<{ change_request_id: string; changes: unknown }>(
    `SELECT change_request_id, changes FROM booking_change_requests
     WHERE booking_id = $1 AND status = 'pending' FOR UPDATE`,
    [input.bookingId]
  );
  for (const row of result.rows) {
    const changes = asChanges(row.changes);
    const fields = Object.entries(changes);
    const matching = fields.length > 0 && fields.every(([field, change]) => JSON.stringify(input.providerValues[field]) === JSON.stringify(change.to));
    if (matching) {
      await input.client.query(
        `UPDATE booking_change_requests SET status = 'completed', completed_at = now(), resolution = '{"source":"provider_sync"}'::jsonb WHERE change_request_id = $1`,
        [row.change_request_id]
      );
      continue;
    }
    const conflict = fields.some(([field, change]) => {
      const actual = input.providerValues[field];
      return JSON.stringify(actual) !== JSON.stringify(change.from) && JSON.stringify(actual) !== JSON.stringify(change.to);
    });
    if (conflict) {
      await input.client.query(
        `UPDATE booking_change_requests SET status = 'conflict', completed_at = now(), resolution = $2::jsonb WHERE change_request_id = $1`,
        [row.change_request_id, JSON.stringify({ source: 'provider_sync', providerValues: input.providerValues })]
      );
    }
  }
}

export async function resolveBookingChangeRequestByAdmin(input: {
  client: PoolClient;
  bookingId: string;
  changeRequestId: string;
  action: 'accept_external' | 'keep_requested' | 'cancel';
  resolvedBy: string;
}): Promise<{ changes: BookingChangeSet; providerKey: string; status: BookingChangeRequestStatus }> {
  const current = await input.client.query<{ changes: unknown; resolution: unknown; provider_key: string }>(
    `SELECT changes, resolution, provider_key
     FROM booking_change_requests
     WHERE change_request_id = $1 AND booking_id = $2 AND status IN ('pending', 'conflict')
     FOR UPDATE`,
    [input.changeRequestId, input.bookingId]
  );
  if (!current.rowCount) throw new Error('Booking change request is no longer active.');

  const priorResolution = current.rows[0].resolution && typeof current.rows[0].resolution === 'object'
    ? current.rows[0].resolution as Record<string, unknown>
    : {};
  const providerValues = priorResolution.providerValues && typeof priorResolution.providerValues === 'object'
    ? priorResolution.providerValues as Record<string, unknown>
    : {};
  const changes = asChanges(current.rows[0].changes);
  const reopenedChanges = Object.fromEntries(
    Object.entries(changes).map(([field, change]) => [field, {
      ...change,
      from: field in providerValues ? providerValues[field] : change.from
    }])
  );
  const status = input.action === 'keep_requested' ? 'pending' : input.action === 'accept_external' ? 'completed' : 'cancelled';
  await input.client.query(
    `UPDATE booking_change_requests
     SET changes = $3::jsonb,
         status = $4,
         completed_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END,
         resolved_by = $5,
         resolution = $6::jsonb
     WHERE change_request_id = $1 AND booking_id = $2`,
    [
      input.changeRequestId,
      input.bookingId,
      JSON.stringify(input.action === 'keep_requested' ? reopenedChanges : changes),
      status,
      input.resolvedBy,
      JSON.stringify({ action: input.action, previousResolution: priorResolution })
    ]
  );
  return {
    changes: input.action === 'keep_requested' ? reopenedChanges : changes,
    providerKey: current.rows[0].provider_key,
    status
  };
}
