import { pool } from '../../db/client.js';
import type {
  CreateDashboardTaskInput,
  DashboardTask,
  DashboardTaskMutationActor,
  DashboardTaskOwner,
  DashboardTaskRawJson,
  DashboardTaskRawJsonValue,
  ListDashboardTasksFilters,
  UpdateDashboardTaskInput
} from '../types.js';
import {
  type AssignableUserRow,
  type Queryable,
  type TaskRow,
  DashboardNotFoundError,
  DashboardValidationError,
  appendTaskUpdateActivity,
  createCreatedActivityLog,
  mapTaskRow,
  toIsoStringOrThrow,
  toStoredTaskColumnId
} from './core.js';
import { resolveTaskColumnForCreate, resolveTaskColumnForUpdate } from './task-columns.js';

const TASK_SELECT_QUERY = `SELECT
   t.id,
   t.title,
   t.description,
   t.created_at,
   t.updated_at,
   t.connected_booking_key,
   t.update_log,
   t.raw_json,
   t.event_date_time,
   t.reminder_date,
   t.reserved_capacity_date,
   c.id AS column_id,
   c.title AS column_title,
   c.position AS column_position,
   c.booking_related,
   u.id AS assignee_user_id,
   u.display_name AS owner_name,
   u.role AS owner_role
  FROM tasks t
  LEFT JOIN task_kanban_columns c ON c.id = t.column_key
  LEFT JOIN users u ON u.id = t.assignee_user_id`;

const TASK_ORDER_BY = `ORDER BY
   CASE WHEN t.column_key IS NULL THEN 1 ELSE 0 END ASC,
   c.position ASC NULLS LAST,
   t.updated_at DESC`;
const RESERVED_TASK_RAW_JSON_KEYS = new Set([
  'columnId',
  'connectedBookingId',
  'description',
  'eventDateTime',
  'ownerId',
  'reminderDate',
  'reservedCapacityDate',
  'site',
  'title'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskRawJsonValue(value: unknown): value is DashboardTaskRawJsonValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function sanitizeTaskRawJson(rawJson: unknown): DashboardTaskRawJson {
  if (!isRecord(rawJson)) {
    return {};
  }

  return Object.entries(rawJson).reduce<DashboardTaskRawJson>((result, [key, value]) => {
    if (RESERVED_TASK_RAW_JSON_KEYS.has(key) || !isTaskRawJsonValue(value)) {
      return result;
    }

    result[key] = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : value;
    return result;
  }, {});
}

function buildTaskRawJson(site: string, rawJson: unknown, existingRawJson?: unknown): DashboardTaskRawJson {
  return {
    ...sanitizeTaskRawJson(existingRawJson),
    ...sanitizeTaskRawJson(rawJson),
    site: site.trim()
  };
}

async function ensureOwner(client: Queryable, ownerId?: string | null): Promise<DashboardTaskOwner | null> {
  if (!ownerId) {
    return null;
  }

  const result = await client.query<AssignableUserRow>(
    `SELECT id, display_name, role
     FROM users
     WHERE id = $1 AND is_active = true AND can_access_dashboard = true
     LIMIT 1`,
    [ownerId]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('Assigned user not found.');
  }

  return { id: result.rows[0].id, name: result.rows[0].display_name, role: result.rows[0].role };
}

async function queryTaskRow(executor: Queryable, taskId: string, forUpdate = false): Promise<TaskRow | null> {
  const result = await executor.query<TaskRow>(
    `${TASK_SELECT_QUERY}
     WHERE t.id = $1 AND t.is_deleted = false
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    [taskId]
  );

  return result.rowCount ? result.rows[0] : null;
}

export async function getTask(taskId: string): Promise<DashboardTask> {
  const row = await queryTaskRow(pool, taskId);
  if (!row) {
    throw new DashboardNotFoundError('Task not found.');
  }

  return mapTaskRow(row);
}

function buildListTasksQuery(filters: ListDashboardTasksFilters = {}): { query: string; values: Array<number | string> } {
  const values: Array<number | string> = [];
  const where: string[] = ['t.is_deleted = false'];

  if (filters.columnId) {
    if (filters.columnId === 'none') {
      where.push('t.column_key IS NULL');
    } else {
      values.push(filters.columnId);
      where.push(`t.column_key = $${values.length}::uuid`);
    }
  }

  if (filters.ownerId) {
    values.push(filters.ownerId);
    where.push(`t.assignee_user_id = $${values.length}::uuid`);
  }

  if (filters.connectedBookingId) {
    values.push(filters.connectedBookingId);
    where.push(`t.connected_booking_key = $${values.length}::uuid`);
  }

  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    const searchParam = `$${values.length}`;
    where.push(`(
      t.title ILIKE ${searchParam}
      OR COALESCE(t.description, '') ILIKE ${searchParam}
      OR COALESCE(t.status, '') ILIKE ${searchParam}
      OR COALESCE(u.display_name, '') ILIKE ${searchParam}
      OR COALESCE(c.title, '') ILIKE ${searchParam}
      OR COALESCE(t.raw_json ->> 'site', '') ILIKE ${searchParam}
    )`);
  }

  let limitClause = '';
  if (typeof filters.limit === 'number') {
    values.push(filters.limit);
    limitClause = `LIMIT $${values.length}`;
  }

  return {
    query: `${TASK_SELECT_QUERY}
     WHERE ${where.join(' AND ')}
     ${TASK_ORDER_BY}
     ${limitClause}`.trim(),
    values
  };
}

export async function listTasks(filters: ListDashboardTasksFilters = {}): Promise<DashboardTask[]> {
  const { query, values } = buildListTasksQuery(filters);
  const result = await pool.query<TaskRow>(query, values);
  return result.rows.map(mapTaskRow);
}

export async function listTasksByBookingId(bookingId: string): Promise<DashboardTask[]> {
  return listTasks({ connectedBookingId: bookingId });
}

export async function createTask(input: CreateDashboardTaskInput, actor?: DashboardTaskMutationActor): Promise<DashboardTask> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const column = await resolveTaskColumnForCreate(client, input.columnId);
    const owner = await ensureOwner(client, input.ownerId);
    const eventDateTime = toIsoStringOrThrow(input.eventDateTime, 'eventDateTime');
    const rawJson = buildTaskRawJson(input.site, input.rawJson);

    const created = await client.query<{ id: string }>(
      `INSERT INTO tasks (
         column_key,
         title,
         description,
         status,
         assignee_user_id,
         update_log,
         raw_json,
         connected_booking_key,
         event_date_time,
         reminder_date,
         reserved_capacity_date
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        toStoredTaskColumnId(column),
        input.title.trim(),
        input.description.trim(),
        column.title,
        owner?.id ?? null,
        JSON.stringify(createCreatedActivityLog(actor)),
        JSON.stringify(rawJson),
        input.connectedBookingId ?? null,
        eventDateTime,
        input.reminderDate ?? null,
        input.reservedCapacityDate ?? null
      ]
    );

    await client.query('COMMIT');
    return await getTask(created.rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateTask(
  taskId: string,
  input: UpdateDashboardTaskInput,
  actor?: DashboardTaskMutationActor
): Promise<DashboardTask> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingRow = await queryTaskRow(client, taskId, true);
    if (!existingRow) {
      throw new DashboardNotFoundError('Task not found.');
    }

    const existingTask = mapTaskRow(existingRow);
    const column = await resolveTaskColumnForUpdate(client, input.columnId);
    const owner = await ensureOwner(client, input.ownerId);
    const rawJson = buildTaskRawJson(input.site, input.rawJson, existingRow.raw_json);

    await client.query(
      `UPDATE tasks
       SET
         column_key = $1,
         title = $2,
         description = $3,
         status = $4,
         assignee_user_id = $5,
         update_log = $6,
         raw_json = $7,
         connected_booking_key = $8,
         event_date_time = $9,
         reminder_date = $10,
         reserved_capacity_date = $11
       WHERE id = $12`,
      [
        toStoredTaskColumnId(column),
        input.title.trim(),
        input.description.trim(),
        column.title,
        owner?.id ?? null,
        JSON.stringify(appendTaskUpdateActivity(existingTask, input, actor, column, owner)),
        JSON.stringify(rawJson),
        input.connectedBookingId ?? null,
        input.eventDateTime,
        input.reminderDate ?? null,
        input.reservedCapacityDate ?? null,
        taskId
      ]
    );

    await client.query('COMMIT');
    return await getTask(taskId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteTask(taskId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE tasks
     SET is_deleted = true
     WHERE id = $1
       AND is_deleted = false`,
    [taskId]
  );

  if (!result.rowCount) {
    throw new DashboardNotFoundError('Task not found.');
  }
}

interface ListDeletedTasksFilters {
  limit?: number;
}

export async function listDeletedTasks(filters: ListDeletedTasksFilters = {}): Promise<DashboardTask[]> {
  let limitClause = '';
  if (typeof filters.limit === 'number') {
    limitClause = `LIMIT ${filters.limit}`;
  }

  const result = await pool.query<TaskRow>(
    `${TASK_SELECT_QUERY}
     WHERE t.is_deleted = true
     ${TASK_ORDER_BY}
     ${limitClause}`.trim()
  );

  return result.rows.map(mapTaskRow);
}

export async function restoreTask(taskId: string): Promise<DashboardTask> {
  const result = await pool.query(
    `UPDATE tasks
     SET is_deleted = false
     WHERE id = $1
       AND is_deleted = true`,
    [taskId]
  );

  if (!result.rowCount) {
    throw new DashboardNotFoundError('Deleted task not found.');
  }

  return await getTask(taskId);
}
