import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import type {
  CreateDashboardTaskBookingOptionInput,
  DashboardTaskBookingOption,
  DashboardTaskBookingOptionGroup,
  ReorderDashboardTaskBookingOptionsInput,
  UpdateDashboardTaskBookingOptionInput
} from '../types.js';
import {
  DashboardNotFoundError,
  DashboardValidationError,
  requireIsoString,
  type Queryable
} from './core.js';

interface TaskBookingOptionRow {
  id: string;
  group_key: DashboardTaskBookingOptionGroup;
  value: string;
  label_en: string;
  label_de: string;
  position: number;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const TASK_BOOKING_OPTION_GROUP_ORDER: DashboardTaskBookingOptionGroup[] = [
  'catering_size',
  'beverage_package',
  'choice_block'
];

function mapTaskBookingOptionRow(row: TaskBookingOptionRow): DashboardTaskBookingOption {
  return {
    id: row.id,
    groupKey: row.group_key,
    value: row.value,
    labelEn: row.label_en,
    labelDe: row.label_de,
    position: row.position,
    isActive: row.is_active,
    createdAt: requireIsoString(row.created_at, 'task_booking_options.created_at'),
    updatedAt: requireIsoString(row.updated_at, 'task_booking_options.updated_at')
  };
}

function normalizeLabel(value: string | undefined, fieldName: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new DashboardValidationError(`${fieldName} is required.`);
  }

  return normalized;
}

function createOptionValue(label: string): string {
  const value = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!value || value === 'none') {
    throw new DashboardValidationError('Task booking option value could not be generated from the label.');
  }

  return value;
}

function isDatabaseError(error: unknown): error is { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null;
}

function throwTaskBookingOptionMutationError(error: unknown): never {
  if (isDatabaseError(error)) {
    if (error.code === '23505') {
      if (typeof error.constraint === 'string' && error.constraint.includes('group_value')) {
        throw new DashboardValidationError('A task booking option with this value already exists.');
      }

      throw new DashboardValidationError('Task booking option order could not be saved. Try again.');
    }

    if (error.code === '23514') {
      throw new DashboardValidationError('Invalid task booking option payload.');
    }
  }

  throw error;
}

async function listTaskBookingOptionRowsForUpdate(
  client: PoolClient,
  groupKey: DashboardTaskBookingOptionGroup
): Promise<TaskBookingOptionRow[]> {
  const result = await client.query<TaskBookingOptionRow>(
    `SELECT id, group_key, value, label_en, label_de, position, is_active, created_at, updated_at
     FROM task_booking_options
     WHERE group_key = $1
     ORDER BY position ASC
     FOR UPDATE`,
    [groupKey]
  );

  return result.rows;
}

async function getTaskBookingOptionRow(
  executor: Queryable,
  optionId: string,
  forUpdate = false
): Promise<TaskBookingOptionRow | null> {
  const result = await executor.query<TaskBookingOptionRow>(
    `SELECT id, group_key, value, label_en, label_de, position, is_active, created_at, updated_at
     FROM task_booking_options
     WHERE id = $1
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [optionId]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function isTaskBookingOptionReferenced(
  executor: Queryable,
  groupKey: DashboardTaskBookingOptionGroup,
  value: string
): Promise<boolean> {
  const result = await executor.query<{ is_referenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM tasks
       WHERE CASE
         WHEN $1 = 'catering_size' THEN raw_json #>> '{booking_data,catering_size}' = $2
         WHEN $1 = 'beverage_package' THEN raw_json #>> '{booking_data,beverage_package}' = $2
         WHEN $1 = 'choice_block' THEN
           CASE jsonb_typeof(raw_json #> '{booking_data,choice_block}')
             WHEN 'array' THEN (raw_json #> '{booking_data,choice_block}') ? $2
             WHEN 'string' THEN raw_json #>> '{booking_data,choice_block}' = $2
             ELSE false
           END
         ELSE false
       END
       LIMIT 1
     ) AS is_referenced`,
    [groupKey, value]
  );

  return result.rows[0]?.is_referenced === true;
}

async function persistTaskBookingOptionPositions(
  client: PoolClient,
  orderedOptionIds: string[]
): Promise<void> {
  if (!orderedOptionIds.length) {
    return;
  }

  await client.query(
    `UPDATE task_booking_options
     SET position = position + $2
     WHERE id = ANY($1::uuid[])`,
    [orderedOptionIds, orderedOptionIds.length + 1]
  );

  const assignments = orderedOptionIds
    .map((_, index) => `($${index * 2 + 1}::uuid, $${index * 2 + 2}::integer)`)
    .join(', ');

  await client.query(
    `UPDATE task_booking_options AS option
     SET position = assignment.position
     FROM (VALUES ${assignments}) AS assignment(id, position)
     WHERE option.id = assignment.id`,
    orderedOptionIds.flatMap((id, index) => [id, index])
  );
}

function resolveTaskBookingOptionReorder(
  orderedOptionIds: string[],
  existingOptions: TaskBookingOptionRow[]
): string[] {
  if (orderedOptionIds.length !== existingOptions.length) {
    throw new DashboardValidationError('orderedOptionIds must include every task booking option in the group exactly once.');
  }

  const existingOptionIds = new Set(existingOptions.map((option) => option.id));
  const seenOptionIds = new Set<string>();

  for (const optionId of orderedOptionIds) {
    if (!existingOptionIds.has(optionId) || seenOptionIds.has(optionId)) {
      throw new DashboardValidationError('orderedOptionIds must include every task booking option in the group exactly once.');
    }

    seenOptionIds.add(optionId);
  }

  return orderedOptionIds;
}

export async function getTaskBookingOption(optionId: string): Promise<DashboardTaskBookingOption> {
  const row = await getTaskBookingOptionRow(pool, optionId);
  if (!row) {
    throw new DashboardNotFoundError('Task booking option not found.');
  }

  return mapTaskBookingOptionRow(row);
}

export async function listTaskBookingOptions(
  groupKey?: DashboardTaskBookingOptionGroup
): Promise<DashboardTaskBookingOption[]> {
  const result = await pool.query<TaskBookingOptionRow>(
    `SELECT id, group_key, value, label_en, label_de, position, is_active, created_at, updated_at
     FROM task_booking_options
     WHERE $1::text IS NULL OR group_key = $1
     ORDER BY array_position($2::text[], group_key), position ASC, label_en ASC`,
    [groupKey ?? null, TASK_BOOKING_OPTION_GROUP_ORDER]
  );

  return result.rows.map(mapTaskBookingOptionRow);
}

export async function createTaskBookingOption(
  input: CreateDashboardTaskBookingOptionInput
): Promise<DashboardTaskBookingOption> {
  const labelEn = normalizeLabel(input.labelEn, 'labelEn');
  const labelDe = normalizeLabel(input.labelDe, 'labelDe');
  const value = createOptionValue(labelEn);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingOptions = await listTaskBookingOptionRowsForUpdate(client, input.groupKey);
    const position = existingOptions.length;
    const result = await client.query<TaskBookingOptionRow>(
      `INSERT INTO task_booking_options (
         group_key,
         value,
         label_en,
         label_de,
         position,
         is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, group_key, value, label_en, label_de, position, is_active, created_at, updated_at`,
      [input.groupKey, value, labelEn, labelDe, position, input.isActive ?? true]
    );
    await client.query('COMMIT');
    return mapTaskBookingOptionRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskBookingOptionMutationError(error);
  } finally {
    client.release();
  }
}

export async function updateTaskBookingOption(
  optionId: string,
  input: UpdateDashboardTaskBookingOptionInput
): Promise<DashboardTaskBookingOption> {
  const existing = await getTaskBookingOption(optionId);
  const labelEn = input.labelEn === undefined ? existing.labelEn : normalizeLabel(input.labelEn, 'labelEn');
  const labelDe = input.labelDe === undefined ? existing.labelDe : normalizeLabel(input.labelDe, 'labelDe');
  const isActive = input.isActive ?? existing.isActive;

  try {
    const result = await pool.query<TaskBookingOptionRow>(
      `UPDATE task_booking_options
       SET label_en = $1,
           label_de = $2,
           is_active = $3
       WHERE id = $4
       RETURNING id, group_key, value, label_en, label_de, position, is_active, created_at, updated_at`,
      [labelEn, labelDe, isActive, optionId]
    );

    if (!result.rowCount) {
      throw new DashboardNotFoundError('Task booking option not found.');
    }

    return mapTaskBookingOptionRow(result.rows[0]);
  } catch (error) {
    throwTaskBookingOptionMutationError(error);
  }
}

export async function deleteTaskBookingOption(optionId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const option = await getTaskBookingOptionRow(client, optionId, true);
    if (!option) {
      throw new DashboardNotFoundError('Task booking option not found.');
    }

    if (await isTaskBookingOptionReferenced(client, option.group_key, option.value)) {
      throw new DashboardValidationError('Task booking option is still used by tasks. Deactivate it instead.');
    }

    const siblingRows = await listTaskBookingOptionRowsForUpdate(client, option.group_key);
    const remainingOptionIds = siblingRows.filter((sibling) => sibling.id !== option.id).map((sibling) => sibling.id);

    await client.query(
      `DELETE FROM task_booking_options
       WHERE id = $1`,
      [optionId]
    );
    await persistTaskBookingOptionPositions(client, remainingOptionIds);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskBookingOptionMutationError(error);
  } finally {
    client.release();
  }
}

export async function reorderTaskBookingOptions(
  input: ReorderDashboardTaskBookingOptionsInput
): Promise<DashboardTaskBookingOption[]> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingOptions = await listTaskBookingOptionRowsForUpdate(client, input.groupKey);
    const nextOrder = resolveTaskBookingOptionReorder(input.orderedOptionIds, existingOptions);
    const currentOrder = existingOptions.map((option) => option.id);

    if (currentOrder.join('|') !== nextOrder.join('|')) {
      await persistTaskBookingOptionPositions(client, nextOrder);
    }

    await client.query('COMMIT');
    return await listTaskBookingOptions(input.groupKey);
  } catch (error) {
    await client.query('ROLLBACK');
    throwTaskBookingOptionMutationError(error);
  } finally {
    client.release();
  }
}
