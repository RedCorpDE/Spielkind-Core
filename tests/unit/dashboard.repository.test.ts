import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    query: queryMock,
    connect: vi.fn()
  }
}));

import { getDashboardSummary } from '../../src/dashboard/repository/summary.js';
import { mapTaskRow, resolveTaskColumnReorderOrder } from '../../src/dashboard/repository/core.js';
import { assertRoleExists, getRoleByIdentifier, listRoles } from '../../src/dashboard/repository/roles.js';
import { listTasks } from '../../src/dashboard/repository/tasks.js';
import { listBookings } from '../../src/dashboard/repository/bookings.js';

describe('dashboard repository queries', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('counts overdue tasks from event_date_time instead of the retired dueDate payload field', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ total_tasks: '4', overdue_tasks: '2' }]
      })
      .mockResolvedValueOnce({
        rows: [{ column_id: 'none', title: 'Unassigned', position: -1, count: '4' }]
      })
      .mockResolvedValueOnce({
        rows: [{ status: 'pending', count: '3' }]
      })
      .mockResolvedValueOnce({
        rows: [{ total_bookings: '7', pending_bookings: '3' }]
      });

    const summary = await getDashboardSummary();
    const [summaryQuery, summaryParams] = queryMock.mock.calls[0] as [string, string[]];

    expect(summaryQuery).toContain('t.event_date_time < now()');
    expect(summaryQuery).not.toContain("raw_json ->> 'dueDate'");
    expect(summaryParams).toEqual(['done|completed|closed|archive']);
    expect(summary.overdueTasks).toBe(2);
  });

  it('does not search legacy task tags from raw_json', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await listTasks({ search: 'berlin' });
    const [taskQuery, taskValues] = queryMock.mock.calls[0] as [string, string[]];

    expect(taskQuery).toContain("COALESCE(t.raw_json ->> 'site', '') ILIKE");
    expect(taskQuery).not.toContain("raw_json -> 'tags'");
    expect(taskValues).toEqual(['%berlin%']);
  });

  it('preserves extra task raw_json fields in dashboard task responses', () => {
    const task = mapTaskRow({
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Task',
      description: 'Description',
      created_at: '2026-04-28T12:00:00.000Z',
      updated_at: '2026-04-28T12:00:00.000Z',
      connected_booking_key: null,
      update_log: [],
      raw_json: {
        site: 'Berlin',
        booking_data: {
          contact_data: {
            email: 'booking@example.com'
          },
          options: [
            {
              option_id: '720707',
              product_id: '297021',
              variation_id: '315643'
            }
          ],
          payment_method: 'per_invoice',
          qty: 1
        }
      },
      event_date_time: '2026-04-29T10:00:00.000Z',
      reminder_date: null,
      reserved_capacity_date: null,
      column_id: null,
      column_title: null,
      column_position: null,
      booking_related: null,
      assignee_user_id: null,
      owner_name: null,
      owner_role: null
    });

    expect(task.site).toBe('Berlin');
    expect(task.rawJson).toMatchObject({
      site: 'Berlin',
      booking_data: {
        contact_data: {
          email: 'booking@example.com'
        },
        options: [
          {
            option_id: '720707',
            product_id: '297021',
            variation_id: '315643'
          }
        ],
        payment_method: 'per_invoice',
        qty: 1
      }
    });
  });

  it('lists bookings by newest event date by default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await listBookings();

    const [bookingQuery, bookingValues] = queryMock.mock.calls[0] as [string, Array<string | number>];
    expect(bookingQuery).toContain('ORDER BY b.dt_from DESC, b.booking_id DESC');
    expect(bookingValues).toEqual([51]);
  });

  it('applies global search and combined booking filters before pagination', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await listBookings({
      depositStatus: 'paid',
      direction: 'asc',
      externalSyncStatus: 'conflict',
      from: '2026-03-28T23:00:00.000Z',
      limit: 10,
      locationId: '11111111-1111-4111-8111-111111111111',
      search: 'Schmidt',
      sort: 'lastUpdated',
      status: 'Confirmed',
      to: '2026-03-29T21:59:59.999Z'
    });

    const [bookingQuery, bookingValues] = queryMock.mock.calls[0] as [string, Array<string | number>];
    expect(bookingQuery).toContain('b.status = $1');
    expect(bookingQuery).toContain("request.status = $2");
    expect(bookingQuery).toContain('b.location_id = $3::uuid');
    expect(bookingQuery).toContain('(b.paid_amount > 0 OR b.paid_amount >= b.total_amount)');
    expect(bookingQuery).toContain('b.dt_from >= $4::timestamptz');
    expect(bookingQuery).toContain('b.dt_from <= $5::timestamptz');
    expect(bookingQuery).toContain('ILIKE $6');
    expect(bookingQuery.indexOf('ILIKE $6')).toBeLessThan(bookingQuery.indexOf('LIMIT $7'));
    expect(bookingQuery).toContain('ORDER BY b.updated_at ASC, b.booking_id ASC');
    expect(bookingValues).toEqual([
      'confirmed',
      'conflict',
      '11111111-1111-4111-8111-111111111111',
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T21:59:59.999Z',
      '%Schmidt%',
      11
    ]);
  });

  it('applies the inverse of the booking deposit-paid rule for pending deposits', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await listBookings({ depositStatus: 'pending' });

    const [bookingQuery] = queryMock.mock.calls[0] as [string, Array<string | number>];
    expect(bookingQuery).toContain('NOT (b.paid_amount > 0 OR b.paid_amount >= b.total_amount)');
  });

  it('rejects inverted booking date ranges before querying', async () => {
    await expect(listBookings({
      from: '2026-05-02T00:00:00.000Z',
      to: '2026-05-01T23:59:59.999Z'
    })).rejects.toThrow('from must be before or equal to to');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('validates task column reorders against the complete current set', () => {
    const existingColumns = [
      { id: '11111111-1111-1111-1111-111111111111', title: 'Backlog', booking_related: false, position: 0 },
      { id: '22222222-2222-2222-2222-222222222222', title: 'Doing', booking_related: false, position: 1 },
      { id: '33333333-3333-3333-3333-333333333333', title: 'Done', booking_related: false, position: 2 }
    ];

    expect(
      resolveTaskColumnReorderOrder(
        [
          '22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333'
        ],
        existingColumns
      )
    ).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333'
    ]);

    expect(() =>
      resolveTaskColumnReorderOrder(
        [
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333'
        ],
        existingColumns
      )
    ).toThrow(/orderedColumnIds must include every task column exactly once/i);

    expect(() =>
      resolveTaskColumnReorderOrder(
        [
          '22222222-2222-2222-2222-222222222222',
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333'
        ],
        existingColumns
      )
    ).toThrow(/orderedColumnIds must include every task column exactly once/i);
  });

  it('lists roles from the current role table with stable keys', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: 'admin', name: 'Admin', description: null, is_system: true },
        { key: 'operations', name: 'Operations', description: 'Operations team', is_system: false }
      ]
    });

    await expect(listRoles()).resolves.toEqual([
      { key: 'admin', name: 'Admin', description: null, isSystem: true },
      { key: 'operations', name: 'Operations', description: 'Operations team', isSystem: false }
    ]);
  });

  it('resolves canonical role names from role keys and names', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ key: 'admin', name: 'Admin', description: null, is_system: true }]
    });

    await expect(assertRoleExists('admin')).resolves.toBe('Admin');
  });

  it('finds roles by either key or display name', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ key: 'operations', name: 'Operations', description: null, is_system: false }]
    });

    await expect(getRoleByIdentifier('Operations')).resolves.toEqual({
      key: 'operations',
      name: 'Operations',
      description: null,
      isSystem: false
    });
  });
});
