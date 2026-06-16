import { pool } from '../../db/client.js';
import type {
  CreateDashboardTaskCommentInput,
  DashboardTaskComment
} from '../types.js';
import {
  DashboardNotFoundError,
  DashboardValidationError,
  requireIsoString
} from './core.js';

interface TaskCommentRow {
  id: string;
  task_id: string;
  author_user_id: string | null;
  author_name: string;
  author_role: string;
  body: string;
  created_at: Date | string;
}

interface TaskCommentTargetRow {
  id: string;
  is_deleted: boolean;
}

function mapTaskCommentRow(row: TaskCommentRow): DashboardTaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: {
      id: row.author_user_id,
      name: row.author_name,
      role: row.author_role
    },
    body: row.body,
    createdAt: requireIsoString(row.created_at, 'task_comments.created_at')
  };
}

async function getTaskCommentTarget(taskId: string): Promise<TaskCommentTargetRow> {
  const result = await pool.query<TaskCommentTargetRow>(
    `SELECT id, is_deleted
     FROM tasks
     WHERE id = $1
     LIMIT 1`,
    [taskId]
  );

  if (!result.rowCount) {
    throw new DashboardNotFoundError('Task not found.');
  }

  return result.rows[0];
}

export async function listTaskComments(taskId: string): Promise<DashboardTaskComment[]> {
  await getTaskCommentTarget(taskId);

  const result = await pool.query<TaskCommentRow>(
    `SELECT
       id,
       task_id,
       author_user_id,
       author_name,
       author_role,
       body,
       created_at
     FROM task_comments
     WHERE task_id = $1
     ORDER BY created_at DESC, id DESC`,
    [taskId]
  );

  return result.rows.map(mapTaskCommentRow);
}

export async function createTaskComment(
  taskId: string,
  input: CreateDashboardTaskCommentInput
): Promise<DashboardTaskComment> {
  const body = input.body.trim();
  if (!body) {
    throw new DashboardValidationError('Comment body is required.');
  }

  const target = await getTaskCommentTarget(taskId);
  if (target.is_deleted) {
    throw new DashboardValidationError('Deleted tasks cannot be commented on.');
  }

  const result = await pool.query<TaskCommentRow>(
    `INSERT INTO task_comments (
       task_id,
       author_user_id,
       author_name,
       author_role,
       body
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING
       id,
       task_id,
       author_user_id,
       author_name,
       author_role,
       body,
       created_at`,
    [
      target.id,
      input.author.id,
      input.author.name.trim(),
      input.author.role.trim(),
      body
    ]
  );

  return mapTaskCommentRow(result.rows[0]);
}
