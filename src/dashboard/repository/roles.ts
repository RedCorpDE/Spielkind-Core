import { pool } from '../../db/client.js';
import type { DashboardRole } from '../types.js';
import { DashboardNotFoundError, DashboardValidationError } from './core.js';

interface DashboardRoleRow {
  name: string;
  is_system: boolean;
}

function mapDashboardRole(row: DashboardRoleRow): DashboardRole {
  return {
    isSystem: row.is_system,
    name: row.name
  };
}

export function normalizeRoleName(role: string): string {
  return role
    .trim()
    .replace(/\s+/g, ' ');
}

export async function listRoles(): Promise<DashboardRole[]> {
  const result = await pool.query<DashboardRoleRow>(
    `SELECT name, is_system
     FROM user_roles
     ORDER BY is_system DESC, name ASC`
  );

  return result.rows.map(mapDashboardRole);
}

export async function assertRoleExists(role: string): Promise<string> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  const result = await pool.query<{ exists: number }>(
    `SELECT 1 AS exists
     FROM user_roles
     WHERE name = $1
     LIMIT 1`,
    [normalizedRole]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('Invalid role specified.');
  }

  return normalizedRole;
}

export async function createRole(role: string): Promise<DashboardRole> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  const result = await pool.query<DashboardRoleRow>(
    `INSERT INTO user_roles (name)
     VALUES ($1)
     ON CONFLICT (name) DO NOTHING
     RETURNING name, is_system`,
    [normalizedRole]
  );

  if (!result.rowCount) {
    throw new DashboardValidationError('This role already exists.');
  }

  return mapDashboardRole(result.rows[0]);
}

export async function deleteRole(role: string): Promise<void> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  const existingRole = await pool.query<DashboardRoleRow>(
    `SELECT name, is_system
     FROM user_roles
     WHERE name = $1
     LIMIT 1`,
    [normalizedRole]
  );

  if (!existingRole.rowCount) {
    throw new DashboardNotFoundError('Role not found.');
  }

  if (existingRole.rows[0].is_system) {
    throw new DashboardValidationError('System roles cannot be removed.');
  }

  const assignedUsers = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM users
     WHERE role = $1`,
    [normalizedRole]
  );

  if (Number(assignedUsers.rows[0]?.count ?? 0) > 0) {
    throw new DashboardValidationError('Cannot remove a role that is still assigned to users.');
  }

  await pool.query(
    `DELETE FROM user_roles
     WHERE name = $1`,
    [normalizedRole]
  );
}
