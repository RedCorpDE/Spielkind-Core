import { pool } from '../../db/client.js';
import type { DashboardRole } from '../types.js';
import { DashboardNotFoundError, DashboardValidationError } from './core.js';

interface DashboardRoleRow {
  name: string;
  is_system: boolean;
}

interface LegacyRoleRow {
  name: string;
}

const DEFAULT_ROLES: DashboardRole[] = [
  { name: 'Admin', isSystem: true },
  { name: 'Operations', isSystem: false },
  { name: 'Operations Lead', isSystem: false },
  { name: 'Program Manager', isSystem: false },
  { name: 'Finance Coordinator', isSystem: false },
  { name: 'People Operations', isSystem: false }
];

const USER_ROLES_MIGRATION_REQUIRED_MESSAGE =
  'Role management requires the latest database migration. Run migrations and try again.';

function mapDashboardRole(row: DashboardRoleRow): DashboardRole {
  return {
    isSystem: row.is_system,
    name: row.name
  };
}

function sortRoles(left: DashboardRole, right: DashboardRole): number {
  if (left.isSystem !== right.isSystem) {
    return left.isSystem ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

function isDatabaseError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null;
}

function isMissingUserRolesTableError(error: unknown): boolean {
  return isDatabaseError(error) && error.code === '42P01';
}

export function normalizeRoleName(role: string): string {
  return role
    .trim()
    .replace(/\s+/g, ' ');
}

function mergeLegacyRoles(rows: LegacyRoleRow[]): DashboardRole[] {
  const rolesByKey = new Map<string, DashboardRole>();

  for (const role of DEFAULT_ROLES) {
    rolesByKey.set(role.name.toLowerCase(), role);
  }

  for (const row of rows) {
    const normalizedRole = normalizeRoleName(row.name);
    if (!normalizedRole) {
      continue;
    }

    const key = normalizedRole.toLowerCase();
    if (!rolesByKey.has(key)) {
      rolesByKey.set(key, { name: normalizedRole, isSystem: false });
    }
  }

  return [...rolesByKey.values()].sort(sortRoles);
}

async function listLegacyRoles(): Promise<DashboardRole[]> {
  const result = await pool.query<LegacyRoleRow>(
    `SELECT DISTINCT btrim(role) AS name
     FROM users
     WHERE role IS NOT NULL
       AND btrim(role) <> ''`
  );

  return mergeLegacyRoles(result.rows);
}

export async function listRoles(): Promise<DashboardRole[]> {
  try {
    const result = await pool.query<DashboardRoleRow>(
      `SELECT name, is_system
       FROM user_roles
       ORDER BY is_system DESC, name ASC`
    );

    return result.rows.map(mapDashboardRole);
  } catch (error) {
    if (isMissingUserRolesTableError(error)) {
      return listLegacyRoles();
    }

    throw error;
  }
}

export async function assertRoleExists(role: string): Promise<string> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  try {
    const result = await pool.query<{ name: string }>(
      `SELECT name
       FROM user_roles
       WHERE name = $1
       LIMIT 1`,
      [normalizedRole]
    );

    if (!result.rowCount) {
      throw new DashboardValidationError('Invalid role specified.');
    }

    return result.rows[0].name;
  } catch (error) {
    if (isMissingUserRolesTableError(error)) {
      const legacyRoles = await listLegacyRoles();
      const matchingRole = legacyRoles.find((candidate) => candidate.name.toLowerCase() === normalizedRole.toLowerCase());

      if (!matchingRole) {
        throw new DashboardValidationError('Invalid role specified.');
      }

      return matchingRole.name;
    }

    throw error;
  }
}

export async function createRole(role: string): Promise<DashboardRole> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  try {
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
  } catch (error) {
    if (isMissingUserRolesTableError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}

export async function deleteRole(role: string): Promise<void> {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  try {
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
  } catch (error) {
    if (isMissingUserRolesTableError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}
