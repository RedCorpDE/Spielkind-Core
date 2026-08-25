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

function comparableProviderValue(field: string, value: unknown): string {
  let normalized = value;
  if (field === 'products' && Array.isArray(value)) {
    normalized = [...value].sort((left, right) => {
      const leftId = left && typeof left === 'object' ? String((left as Record<string, unknown>).productId ?? '') : '';
      const rightId = right && typeof right === 'object' ? String((right as Record<string, unknown>).productId ?? '') : '';
      return leftId.localeCompare(rightId);
    });
  }
  if (field === 'schedule' && normalized && typeof normalized === 'object') {
    const schedule = normalized as Record<string, unknown>;
    const normalizeDate = (candidate: unknown) => {
      if (typeof candidate !== 'string') return candidate;
      const date = new Date(candidate);
      return Number.isNaN(date.getTime()) ? candidate : date.toISOString();
    };
    normalized = {
      bookingDate: normalizeDate(schedule.bookingDate),
      bookingEndDate: normalizeDate(schedule.bookingEndDate)
    };
  }
  return JSON.stringify(normalized);
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
     WHERE booking_id = $1 AND status IN ('pending', 'conflict')
     ORDER BY requested_at DESC
     LIMIT 1
     FOR UPDATE`,
    [input.bookingId]
  );
  if (existing.rowCount) {
    const existingChanges = asChanges(existing.rows[0].changes);
    const merged = { ...existingChanges };
    for (const [field, nextChange] of Object.entries(input.changes)) {
      const previousChange = existingChanges[field];
      merged[field] = previousChange
        ? { from: previousChange.from, to: nextChange.to }
        : nextChange;
    }
    for (const [field, change] of Object.entries(merged)) {
      if (comparableProviderValue(field, change.from) === comparableProviderValue(field, change.to)) delete merged[field];
    }
    if (!Object.keys(merged).length) {
      await input.client.query(
        `UPDATE booking_change_requests
         SET changes = '{}'::jsonb, status = 'completed', completed_at = now(),
             resolved_by = $2, resolution = '{"source":"local_revert"}'::jsonb
         WHERE change_request_id = $1`,
        [existing.rows[0].change_request_id, input.requestedBy]
      );
      return;
    }
    await input.client.query(
      `UPDATE booking_change_requests
       SET changes = $2::jsonb,
           requested_at = now(),
           requested_by = $3,
           provider_key = $4,
           status = 'pending',
           completed_at = NULL,
           resolved_by = NULL,
           resolution = NULL
       WHERE change_request_id = $1`,
      [existing.rows[0].change_request_id, JSON.stringify(merged), input.requestedBy, input.providerKey]
    );
    return;
  }
  const effectiveChanges = Object.fromEntries(
    Object.entries(input.changes).filter(([field, change]) => comparableProviderValue(field, change.from) !== comparableProviderValue(field, change.to))
  );
  if (!Object.keys(effectiveChanges).length) return;
  await input.client.query(
    `INSERT INTO booking_change_requests (change_request_id, booking_id, provider_key, requested_by, changes)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), input.bookingId, input.providerKey, input.requestedBy, JSON.stringify(effectiveChanges)]
  );
}

export async function resolveBookingChangeRequests(input: {
  client: PoolClient;
  bookingId: string;
  providerValues: Record<string, unknown>;
}): Promise<void> {
  const result = await input.client.query<{ change_request_id: string; changes: unknown; status: string }>(
    `SELECT change_request_id, changes, status FROM booking_change_requests
     WHERE booking_id = $1 AND status IN ('pending', 'conflict') FOR UPDATE`,
    [input.bookingId]
  );
  for (const row of result.rows) {
    const changes = asChanges(row.changes);
    const fields = Object.entries(changes);
    const matchingFields = fields
      .filter(([field, change]) => comparableProviderValue(field, input.providerValues[field]) === comparableProviderValue(field, change.to))
      .map(([field]) => field);
    const remainingChanges = Object.fromEntries(fields.filter(([field]) => !matchingFields.includes(field)));

    if (matchingFields.length) {
      await input.client.query(
        `UPDATE booking_admin_metadata
         SET local_override_fields = ARRAY(
           SELECT field FROM unnest(COALESCE(local_override_fields, ARRAY[]::text[])) AS field
           WHERE NOT (field = ANY($2::text[]))
         ),
             location_override = CASE WHEN 'location' = ANY($2::text[]) THEN NULL ELSE location_override END,
             updated_at = now()
         WHERE booking_id = $1`,
        [input.bookingId, matchingFields]
      );
    }

    if (!Object.keys(remainingChanges).length) {
      await input.client.query(
        `UPDATE booking_change_requests SET status = 'completed', completed_at = now(), resolution = '{"source":"provider_sync"}'::jsonb WHERE change_request_id = $1`,
        [row.change_request_id]
      );
      continue;
    }
    const conflict = Object.entries(remainingChanges).some(([field, change]) => {
      const actual = input.providerValues[field];
      return comparableProviderValue(field, actual) !== comparableProviderValue(field, change.from)
        && comparableProviderValue(field, actual) !== comparableProviderValue(field, change.to);
    });
    if (conflict) {
      await input.client.query(
        `UPDATE booking_change_requests
         SET changes = $2::jsonb, status = 'conflict', completed_at = now(), resolution = $3::jsonb
         WHERE change_request_id = $1`,
        [row.change_request_id, JSON.stringify(remainingChanges), JSON.stringify({ source: 'provider_sync', providerValues: input.providerValues })]
      );
    } else if (matchingFields.length || row.status === 'conflict') {
      await input.client.query(
        `UPDATE booking_change_requests
         SET changes = $2::jsonb, status = 'pending', completed_at = NULL, resolution = NULL
         WHERE change_request_id = $1`,
        [row.change_request_id, JSON.stringify(remainingChanges)]
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
