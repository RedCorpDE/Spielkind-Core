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
import { resolveTaskColumnReorderOrder } from '../../src/dashboard/repository/core.js';
import { listTasks } from '../../src/dashboard/repository/tasks.js';

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
});
