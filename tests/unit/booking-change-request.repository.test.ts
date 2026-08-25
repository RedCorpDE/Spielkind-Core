import { describe, expect, it, vi } from 'vitest';
import {
  createOrMergeBookingChangeRequest,
  resolveBookingChangeRequests
} from '../../src/modules/bookings/booking-change-request.repository.js';

const bookingId = '11111111-1111-1111-1111-111111111111';
const requestId = '22222222-2222-2222-2222-222222222222';

const clientWith = (implementation: (sql: string, values?: unknown[]) => unknown) => ({
  query: vi.fn(async (sql: string, values?: unknown[]) => implementation(sql, values))
}) as never;

describe('booking change request merge and provider reconciliation', () => {
  it('keeps the provider origin and replaces the local target on repeated edits', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT change_request_id')) {
        return {
          rowCount: 1,
          rows: [{
            change_request_id: requestId,
            changes: { attendees: { from: 2, to: 3 } }
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    });
    await createOrMergeBookingChangeRequest({
      client: { query } as never,
      bookingId,
      changes: { attendees: { from: 3, to: 4 } },
      providerKey: 'regiondo',
      requestedBy: 'Admin'
    });

    const update = query.mock.calls.find(([sql]) => sql.includes('SET changes = $2::jsonb'));
    expect(JSON.parse(String(update?.[1]?.[1]))).toEqual({ attendees: { from: 2, to: 4 } });
  });

  it('completes the active request when a local edit returns to the provider value', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT change_request_id')
      ? { rowCount: 1, rows: [{ change_request_id: requestId, changes: { attendees: { from: 2, to: 3 } } }] }
      : { rowCount: 1, rows: [] });

    await createOrMergeBookingChangeRequest({
      client: { query } as never,
      bookingId,
      changes: { attendees: { from: 3, to: 2 } },
      providerKey: 'regiondo',
      requestedBy: 'Admin'
    });

    expect(query.mock.calls.some(([sql]) => sql.includes("status = 'completed'") && sql.includes('local_revert'))).toBe(true);
  });

  it('keeps a request pending when Regiondo still has the original value', async () => {
    const client = clientWith((sql) => sql.includes('SELECT change_request_id')
      ? { rowCount: 1, rows: [{ change_request_id: requestId, status: 'pending', changes: { attendees: { from: 2, to: 3 } } }] }
      : { rowCount: 1, rows: [] });

    await resolveBookingChangeRequests({ client, bookingId, providerValues: { attendees: 2 } });
    expect((client as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });

  it('clears the override and completes the request when Regiondo matches the local value', async () => {
    const client = clientWith((sql) => sql.includes('SELECT change_request_id')
      ? { rowCount: 1, rows: [{ change_request_id: requestId, status: 'pending', changes: { attendees: { from: 2, to: 3 } } }] }
      : { rowCount: 1, rows: [] });

    await resolveBookingChangeRequests({ client, bookingId, providerValues: { attendees: 3 } });
    const calls = (client as { query: ReturnType<typeof vi.fn> }).query.mock.calls;
    expect(calls.some(([sql]) => sql.includes('UPDATE booking_admin_metadata'))).toBe(true);
    expect(calls.some(([sql]) => sql.includes("status = 'completed'") && sql.includes('provider_sync'))).toBe(true);
  });

  it('marks a third provider value as a conflict without replacing the local target', async () => {
    const client = clientWith((sql) => sql.includes('SELECT change_request_id')
      ? { rowCount: 1, rows: [{ change_request_id: requestId, status: 'pending', changes: { attendees: { from: 2, to: 3 } } }] }
      : { rowCount: 1, rows: [] });

    await resolveBookingChangeRequests({ client, bookingId, providerValues: { attendees: 4 } });
    const conflict = (client as { query: ReturnType<typeof vi.fn> }).query.mock.calls.find(
      ([sql]) => sql.includes("status = 'conflict'")
    );
    expect(conflict).toBeDefined();
    expect(JSON.parse(String(conflict?.[1]?.[1]))).toEqual({ attendees: { from: 2, to: 3 } });
  });
});
