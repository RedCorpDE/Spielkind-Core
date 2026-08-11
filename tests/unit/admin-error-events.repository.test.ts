import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../src/db/client.js', () => ({ pool: { query } }));

const { listAdminErrorEvents, recordAdminErrorEvent } = await import('../../src/errors/admin-error-events.repository.js');

describe('admin error event repository', () => {
  beforeEach(() => query.mockReset());

  it('redacts contact data and drops metadata outside the allowlist', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    await recordAdminErrorEvent({
      actorType: 'system',
      actorName: 'Worker',
      source: 'background_job',
      severity: 'error',
      errorCode: 'BACKGROUND_JOB_FAILED',
      diagnosticSummary: 'Delivery to customer@example.com failed.',
      metadata: { arbitrary: 'submitted form data', attempt: 2 }
    });

    const parameters = query.mock.calls[0][1] as unknown[];
    expect(parameters[7]).toBe('Delivery to [redacted-email] failed.');
    expect(JSON.parse(parameters[22] as string)).toEqual({ attempt: 2 });
  });

  it('applies location scope to rows and facets', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await listAdminErrorEvents({
      scope: 'location',
      userId: '00000000-0000-0000-0000-000000000001',
      locationIds: ['00000000-0000-0000-0000-000000000002'],
      includeDiagnostics: false
    });

    expect(query.mock.calls[0][0]).toContain('e.location_id = ANY');
    expect(query.mock.calls[1][0]).toContain('location_id = ANY');
    expect(query.mock.calls[0][0]).toContain('NULL AS diagnostic_summary');
  });
});
