import { pool } from '../../db/client.js';
import type { DashboardRole } from '../types.js';
import { DashboardNotFoundError, DashboardValidationError } from './core.js';

interface DashboardRoleRow {
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
}

const USER_ROLES_MIGRATION_REQUIRED_MESSAGE =
  'Role management requires the latest database migration. Run migrations and try again.';

function mapDashboardRole(row: DashboardRoleRow): DashboardRole {
  return {
    key: row.key,
    description: row.description,
    isSystem: row.is_system,
    name: row.name
  };
}

function isDatabaseError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null;
}

function isMissingRoleManagementSchemaError(error: unknown): boolean {
  return isDatabaseError(error) && (error.code === '42P01' || error.code === '42703');
}

export function normalizeRoleName(role: string): string {
  return role
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeRoleDescription(description: string | null | undefined): string | null {
  if (typeof description !== 'string') {
    return null;
  }

  const normalized = description.trim();
  return normalized ? normalized : null;
}

function createRoleKeySource(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function createRoleKey(name: string): string {
  const key = createRoleKeySource(name);
  return key || 'role';
}

export async function listRoles(): Promise<DashboardRole[]> {
  try {
    const result = await pool.query<DashboardRoleRow>(
      `SELECT key, name, description, is_system
       FROM user_roles
       ORDER BY is_system DESC, name ASC`
    );

    return result.rows.map(mapDashboardRole);
  } catch (error) {
    if (isMissingRoleManagementSchemaError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}

export async function getRoleByIdentifier(roleIdentifier: string): Promise<DashboardRole | null> {
  const normalizedRoleIdentifier = roleIdentifier.trim();

  if (!normalizedRoleIdentifier) {
    return null;
  }

  try {
    const result = await pool.query<DashboardRoleRow>(
      `SELECT key, name, description, is_system
       FROM user_roles
       WHERE key = $1
          OR name = $1
       LIMIT 1`,
      [normalizedRoleIdentifier]
    );

    return result.rowCount ? mapDashboardRole(result.rows[0]) : null;
  } catch (error) {
    if (isMissingRoleManagementSchemaError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}

export async function assertRoleExists(role: string): Promise<string> {
  if (!role.trim()) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  const roleRecord = await getRoleByIdentifier(role);

  if (!roleRecord) {
    throw new DashboardValidationError('Invalid role specified.');
  }

  return roleRecord.name;
}

async function generateUniqueRoleKey(roleName: string): Promise<string> {
  const baseKey = createRoleKey(roleName);
  const result = await pool.query<{ key: string }>(
    `SELECT key
     FROM user_roles
     WHERE key = $1
        OR key LIKE $2`,
    [baseKey, `${baseKey}_%`]
  );
  const existingKeys = new Set(result.rows.map((row) => row.key));

  if (!existingKeys.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  let nextKey = `${baseKey}_${suffix}`;

  while (existingKeys.has(nextKey)) {
    suffix += 1;
    nextKey = `${baseKey}_${suffix}`;
  }

  return nextKey;
}

export async function createRole(input: {
  name: string;
  description?: string | null;
}): Promise<DashboardRole> {
  const normalizedRole = normalizeRoleName(input.name);

  if (!normalizedRole) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  try {
    const nextKey = await generateUniqueRoleKey(normalizedRole);
    const result = await pool.query<DashboardRoleRow>(
      `INSERT INTO user_roles (key, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING
       RETURNING key, name, description, is_system`,
      [nextKey, normalizedRole, normalizeRoleDescription(input.description)]
    );

    if (!result.rowCount) {
      throw new DashboardValidationError('This role already exists.');
    }

    return mapDashboardRole(result.rows[0]);
  } catch (error) {
    if (isMissingRoleManagementSchemaError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}

export async function updateRole(
  roleIdentifier: string,
  input: {
    name?: string;
    description?: string | null;
  }
): Promise<DashboardRole> {
  if (!roleIdentifier.trim()) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  const existingRole = await getRoleByIdentifier(roleIdentifier);

  if (!existingRole) {
    throw new DashboardNotFoundError('Role not found.');
  }

  const nextName = input.name !== undefined ? normalizeRoleName(input.name) : existingRole.name;
  const nextDescription =
    input.description !== undefined ? normalizeRoleDescription(input.description) : existingRole.description;

  if (!nextName) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  if (existingRole.isSystem && nextName !== existingRole.name) {
    throw new DashboardValidationError('System roles cannot be renamed.');
  }

  const client = await pool.connect();

  try {
    try {
      await client.query('BEGIN');
      const result = await client.query<DashboardRoleRow>(
        `UPDATE user_roles
         SET
           name = $2,
           description = $3
         WHERE key = $1
         RETURNING key, name, description, is_system`,
        [existingRole.key, nextName, nextDescription]
      );

      if (!result.rowCount) {
        throw new DashboardNotFoundError('Role not found.');
      }

      if (existingRole.name !== nextName) {
        await client.query(
          `UPDATE users
           SET role = $1
           WHERE role = $2`,
          [nextName, existingRole.name]
        );
      }

      await client.query('COMMIT');
      return mapDashboardRole(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (isMissingRoleManagementSchemaError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    if (isDatabaseError(error) && error.code === '23505') {
      throw new DashboardValidationError('This role already exists.');
    }

    throw error;
  }
}

export async function deleteRole(roleIdentifier: string): Promise<void> {
  if (!roleIdentifier.trim()) {
    throw new DashboardValidationError('Role name cannot be empty.');
  }

  try {
    const existingRole = await getRoleByIdentifier(roleIdentifier);

    if (!existingRole) {
      throw new DashboardNotFoundError('Role not found.');
    }

    if (existingRole.isSystem) {
      throw new DashboardValidationError('System roles cannot be removed.');
    }

    const assignedUsers = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM users
       WHERE role = $1`,
      [existingRole.name]
    );

    if (Number(assignedUsers.rows[0]?.count ?? 0) > 0) {
      throw new DashboardValidationError('Cannot remove a role that is still assigned to users.');
    }

    await pool.query(
      `DELETE FROM user_roles
       WHERE key = $1`,
      [existingRole.key]
    );
  } catch (error) {
    if (isMissingRoleManagementSchemaError(error)) {
      throw new DashboardValidationError(USER_ROLES_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }
}
