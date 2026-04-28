import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import type {
  CreateDashboardTaskColumnInput,
  DashboardTaskColumn,
  ReorderDashboardTaskColumnsInput,
  UpdateDashboardTaskColumnInput
} from '../types.js';
import {
  DashboardNotFoundError,
  DashboardValidationError,
  type Queryable,
  type TaskColumnRow,
  UNASSIGNED_TASK_COLUMN,
  mapTaskColumnRow,
  resolveTaskColumnInsertPosition,
  resolveTaskColumnReorderOrder,
  resolveTaskColumnUpdatePosition,
  throwTaskColumnMutationError,
  toStoredTaskColumnId
} from './core.js';

async function listTaskColumnRowsForUpdate(client: PoolClient): Promise<TaskColumnRow[]> {
  const result = await client.query<TaskColumnRow>(
    `SELECT id, title, booking_related, position
     FROM task_kanban_columns
     ORDER BY position ASC
     FOR UPDATE`
  );

  return result.rows;
}

async function queryTaskColumnRow(
  executor: Queryable,
  columnId: string,
  forUpdate = false
): Promise<TaskColumnRow | null> {
  const result = await executor.query<TaskColumnRow>(
    `SELECT id, title, booking_related, position
     FROM task_kanban_columns
     WHERE id = $1
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [columnId]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function persistTaskColumnPositions(client: PoolClient, columnIdsInOrder: string[]): Promise<void> {
  if (!columnIdsInOrder.length) {
    return;
  }

  await client.query(`UPDATE task_kanban_columns SET position = position + $2 WHERE id = ANY($1::uuid[])`, [
    columnIdsInOrder,
    columnIdsInOrder.length + 1
  ]);

  const assignments = columnIdsInOrder
    .map((_, index) => `($${index * 2 + 1}::uuid, $${index * 2 + 2}::integer)`)
    .join(', ');

  await client.query(
    `UPDATE task_kanban_columns AS c
     SET position = v.position
     FROM (VALUES ${assignments}) AS v(id, position)
     WHERE c.id = v.id`,
    columnIdsInOrder.flatMap((id, index) => [id, index])
  );
}

async function queryFirstTaskColumn(client: PoolClient): Promise<TaskColumnRow | null> {
  const result = await client.query<TaskColumnRow>(
    `SELECT id, title, booking_related, position
     FROM task_kanban_columns
     ORDER BY position ASC
     LIMIT 1`
  );

  return result.rowCount ? result.rows[0] : null;
}

async function requireStoredTaskColumn(client: PoolClient, columnId: string): Promise<TaskColumnRow> {
  const result = await client.query<TaskColumnRow>(
    `SELECT id, title, booking_related, position
     FROM task_kanban_columns
     WHERE id = $1
     LIMIT 1`,
    [columnId]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('Task column not found.');
  }

  return result.rows[0];
}

export async function resolveTaskColumnForCreate(client: PoolClient, columnId?: string | null): Promise<TaskColumnRow> {
  if (typeof columnId === 'string' && columnId !== UNASSIGNED_TASK_COLUMN.id) {
    return await requireStoredTaskColumn(client, columnId);
  }

  const firstColumn = await queryFirstTaskColumn(client);
  if (columnId === null || columnId === undefined || columnId === UNASSIGNED_TASK_COLUMN.id) {
    if (columnId === UNASSIGNED_TASK_COLUMN.id || columnId === null) {
      if (firstColumn) {
        throw new DashboardValidationError('Cannot assign a task to none while task columns exist.');
      }

      return { ...UNASSIGNED_TASK_COLUMN };
    }
  }

  return firstColumn ?? { ...UNASSIGNED_TASK_COLUMN };
}

export async function resolveTaskColumnForUpdate(client: PoolClient, columnId: string | null): Promise<TaskColumnRow> {
  if (typeof columnId === 'string' && columnId !== UNASSIGNED_TASK_COLUMN.id) {
    return await requireStoredTaskColumn(client, columnId);
  }

  const firstColumn = await queryFirstTaskColumn(client);
  if (firstColumn) {
    throw new DashboardValidationError('Cannot assign a task to none while task columns exist.');
  }

  return { ...UNASSIGNED_TASK_COLUMN };
}

export async function getTaskColumnById(columnId: string): Promise<DashboardTaskColumn> {
  const row = await queryTaskColumnRow(pool, columnId);
  if (!row) {
    throw new DashboardNotFoundError('Task column not found.');
  }

  return mapTaskColumnRow(row);
}

export async function listTaskColumns(): Promise<DashboardTaskColumn[]> {
  const result = await pool.query<TaskColumnRow>(
    `SELECT id, title, booking_related, position
     FROM task_kanban_columns
     ORDER BY position ASC`
  );

  return result.rows.map(mapTaskColumnRow);
}

export async function createTaskColumn(input: CreateDashboardTaskColumnInput): Promise<DashboardTaskColumn> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingColumns = await listTaskColumnRowsForUpdate(client);
    const insertPosition = resolveTaskColumnInsertPosition(input.position, existingColumns.length);
    const created = await client.query<TaskColumnRow>(
      `INSERT INTO task_kanban_columns (title, booking_related, position)
       VALUES ($1, $2, $3)
       RETURNING id, title, booking_related, position`,
      [input.title.trim(), input.bookingRelated, existingColumns.length]
    );

    const reorderedColumns = [...existingColumns];
    reorderedColumns.splice(insertPosition, 0, created.rows[0]);
    await persistTaskColumnPositions(
      client,
      reorderedColumns.map((column) => column.id)
    );

    if (!existingColumns.length) {
      await client.query(
        `UPDATE tasks
         SET column_key = $1, status = $2
         WHERE column_key IS NULL`,
        [created.rows[0].id, created.rows[0].title]
      );
    }

    await client.query('COMMIT');
    return await getTaskColumnById(created.rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskColumnMutationError(error);
  } finally {
    client.release();
  }
}

export async function updateTaskColumn(
  columnId: string,
  input: UpdateDashboardTaskColumnInput
): Promise<DashboardTaskColumn> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingColumns = await listTaskColumnRowsForUpdate(client);
    const currentIndex = existingColumns.findIndex((column) => column.id === columnId);

    if (currentIndex === -1) {
      throw new DashboardNotFoundError('Task column not found.');
    }

    const existingColumn = existingColumns[currentIndex];
    const nextTitle = typeof input.title === 'string' ? input.title.trim() : existingColumn.title;
    const nextBookingRelated =
      typeof input.bookingRelated === 'boolean' ? input.bookingRelated : existingColumn.booking_related;
    const nextPosition = resolveTaskColumnUpdatePosition(input.position, existingColumns.length, existingColumn.position);

    await client.query(
      `UPDATE task_kanban_columns
       SET title = $1, booking_related = $2
       WHERE id = $3`,
      [nextTitle, nextBookingRelated, columnId]
    );

    if (nextTitle !== existingColumn.title) {
      await client.query(
        `UPDATE tasks
         SET status = $1
         WHERE column_key = $2`,
        [nextTitle, columnId]
      );
    }

    const reorderedColumns = [...existingColumns];
    const [updatedColumn] = reorderedColumns.splice(currentIndex, 1);
    reorderedColumns.splice(nextPosition, 0, {
      ...updatedColumn,
      title: nextTitle,
      booking_related: nextBookingRelated
    });

    const originalOrder = existingColumns.map((column) => column.id).join('|');
    const nextOrder = reorderedColumns.map((column) => column.id).join('|');
    if (originalOrder !== nextOrder) {
      await persistTaskColumnPositions(
        client,
        reorderedColumns.map((column) => column.id)
      );
    }

    await client.query('COMMIT');
    return await getTaskColumnById(columnId);
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskColumnMutationError(error);
  } finally {
    client.release();
  }
}

export async function reorderTaskColumns(
  input: ReorderDashboardTaskColumnsInput
): Promise<DashboardTaskColumn[]> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingColumns = await listTaskColumnRowsForUpdate(client);
    const nextOrder = resolveTaskColumnReorderOrder(input.orderedColumnIds, existingColumns);
    const currentOrder = existingColumns.map((column) => column.id);

    if (currentOrder.join('|') !== nextOrder.join('|')) {
      await persistTaskColumnPositions(client, nextOrder);
    }

    await client.query('COMMIT');

    const columnMap = new Map(existingColumns.map((column) => [column.id, column] as const));
    return nextOrder.map((columnId, index) =>
      mapTaskColumnRow({
        ...columnMap.get(columnId)!,
        position: index
      })
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskColumnMutationError(error);
  } finally {
    client.release();
  }
}

export async function deleteTaskColumn(columnId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingColumns = await listTaskColumnRowsForUpdate(client);
    const currentIndex = existingColumns.findIndex((column) => column.id === columnId);

    if (currentIndex === -1) {
      throw new DashboardNotFoundError('Task column not found.');
    }

    const reorderedColumns = existingColumns.filter((column) => column.id !== columnId);
    const fallbackColumn = reorderedColumns[0] ?? { ...UNASSIGNED_TASK_COLUMN };

    await client.query(
      `UPDATE tasks
       SET column_key = $1, status = $2
       WHERE column_key = $3`,
      [toStoredTaskColumnId(fallbackColumn), fallbackColumn.title, columnId]
    );

    await client.query(`DELETE FROM task_kanban_columns WHERE id = $1`, [columnId]);
    await persistTaskColumnPositions(
      client,
      reorderedColumns.map((column) => column.id)
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskColumnMutationError(error);
  } finally {
    client.release();
  }
}
