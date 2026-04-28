import { pool } from '../../db/client.js';
import type { DashboardSummary } from '../types.js';
import { COMPLETED_TASK_PATTERN_SOURCE } from './core.js';

interface BookingStatusSummaryRow {
  status: string;
  count: string | number;
}

interface TaskSummaryCountsRow {
  total_tasks: string | number;
  overdue_tasks: string | number;
}

interface TaskByColumnSummaryRow {
  column_id: string;
  title: string;
  position: number;
  count: string | number;
}

function mapDashboardSummaryStatus(status: string): DashboardSummary['bookingsByStatus'][number]['status'] {
  switch (status) {
    case 'processing':
      return 'Processing';
    case 'confirmed':
      return 'Confirmed';
    case 'completed':
      return 'Completed';
    case 'rejected':
      return 'Rejected';
    case 'canceled':
      return 'Canceled';
    case 'unknown':
      return 'Unknown';
    default:
      return 'Pending';
  }
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [taskCountRow, taskByColumnRows, bookingStatusRows, bookingCountRow] = await Promise.all([
    pool.query<TaskSummaryCountsRow>(
      `SELECT
         COUNT(*) AS total_tasks,
         COUNT(*) FILTER (
           WHERE t.event_date_time < now()
             AND COALESCE(c.title, '') !~* $1
         ) AS overdue_tasks
       FROM tasks t
       LEFT JOIN task_kanban_columns c ON c.id = t.column_key
       WHERE t.is_deleted = false`,
      [COMPLETED_TASK_PATTERN_SOURCE]
    ),
    pool.query<TaskByColumnSummaryRow>(
      `SELECT
         COALESCE(c.id::text, 'none') AS column_id,
         COALESCE(c.title, 'Unassigned') AS title,
         COALESCE(c.position, -1) AS position,
         COUNT(*) AS count
       FROM tasks t
       LEFT JOIN task_kanban_columns c ON c.id = t.column_key
       WHERE t.is_deleted = false
       GROUP BY 1, 2, 3
       ORDER BY
         CASE WHEN COALESCE(c.id::text, 'none') = 'none' THEN 1 ELSE 0 END ASC,
         COALESCE(c.position, -1) ASC,
         COALESCE(c.title, 'Unassigned') ASC`
    ),
    pool.query<BookingStatusSummaryRow>(
      `SELECT
         CASE
           WHEN COALESCE(admin.ops_status, 'normal') = 'escalated' THEN 'Escalated'
           ELSE b.status
         END AS status,
         COUNT(*) AS count
       FROM bookings b
       LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id
       GROUP BY 1`
    ),
    pool.query<{ total_bookings: string | number; pending_bookings: string | number }>(
      `SELECT
         COUNT(*) AS total_bookings,
         COUNT(*) FILTER (
           WHERE b.status IN ('pending', 'processing')
              OR COALESCE(admin.ops_status, 'normal') = 'escalated'
         ) AS pending_bookings
       FROM bookings b
       LEFT JOIN booking_admin_metadata admin ON admin.booking_id = b.booking_id`
    )
  ]);
  const taskCounts = taskCountRow.rows[0];
  const bookingCounts = bookingCountRow.rows[0];

  return {
    totalTasks: Number(taskCounts.total_tasks),
    overdueTasks: Number(taskCounts.overdue_tasks),
    totalBookings: Number(bookingCounts.total_bookings),
    pendingBookings: Number(bookingCounts.pending_bookings),
    tasksByColumn: taskByColumnRows.rows.map((row) => ({
      columnId: row.column_id,
      title: row.title,
      count: Number(row.count)
    })),
    bookingsByStatus: bookingStatusRows.rows.map((row) => ({
      status: row.status === 'Escalated' ? 'Escalated' : mapDashboardSummaryStatus(row.status),
      count: Number(row.count)
    }))
  };
}
