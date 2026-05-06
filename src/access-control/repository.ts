import { pool } from '../db/client.js';
import {
  type AccessContext,
  type AccessRole,
  getDefaultRolePermissions,
  isPermissionAction,
  isPermissionResource,
  isPermissionScope,
  normalizePermissionSet,
  permissionDefinitions,
  type PermissionAction,
  type PermissionResource,
  type PermissionScope,
  type ResolvedPermission,
  type RolePermission
} from './model.js';
import {
  DashboardValidationError
} from '../dashboard/repository/core.js';
import { getRoleByIdentifier, listRoles } from '../dashboard/repository/roles.js';

interface RolePermissionRow {
  role_key: string;
  resource: string;
  action: string;
  scope: string;
}

const ROLE_PERMISSIONS_MIGRATION_REQUIRED_MESSAGE =
  'Access control permissions require the latest database migration. Run migrations and try again.';

function isDatabaseError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null;
}

function isMissingRolePermissionsTableError(error: unknown): boolean {
  return isDatabaseError(error) && error.code === '42P01';
}

function mapRolePermissionRow(row: RolePermissionRow): RolePermission | null {
  if (!isPermissionResource(row.resource) || !isPermissionAction(row.action) || !isPermissionScope(row.scope)) {
    return null;
  }

  return {
    roleKey: row.role_key,
    resource: row.resource,
    action: row.action,
    scope: row.scope
  };
}

async function listStoredRolePermissions(): Promise<RolePermission[]> {
  try {
    const result = await pool.query<RolePermissionRow>(
      `SELECT role_key, resource, action, scope
       FROM role_permissions
       ORDER BY role_key ASC, resource ASC, action ASC`
    );

    return result.rows.flatMap((row) => {
      const permission = mapRolePermissionRow(row);
      return permission ? [permission] : [];
    });
  } catch (error) {
    if (isMissingRolePermissionsTableError(error)) {
      return [];
    }

    throw error;
  }
}

function completeRolePermissions(roleKey: string, permissions: ResolvedPermission[]): RolePermission[] {
  return normalizePermissionSet(permissions).map((permission) => ({
    ...permission,
    roleKey
  }));
}

function groupPermissionsByRoleKey(permissions: RolePermission[]): Map<string, RolePermission[]> {
  const permissionsByRoleKey = new Map<string, RolePermission[]>();

  for (const permission of permissions) {
    const existing = permissionsByRoleKey.get(permission.roleKey) ?? [];
    existing.push(permission);
    permissionsByRoleKey.set(permission.roleKey, existing);
  }

  return permissionsByRoleKey;
}

function normalizeIncomingPermissions(input: Array<{
  resource: PermissionResource;
  action: PermissionAction;
  scope: PermissionScope;
}>): ResolvedPermission[] {
  return normalizePermissionSet(
    input.flatMap((permission) => {
      if (
        !isPermissionResource(permission.resource) ||
        !isPermissionAction(permission.action) ||
        !isPermissionScope(permission.scope)
      ) {
        return [];
      }

      return [
        {
          action: permission.action,
          resource: permission.resource,
          scope: permission.scope
        }
      ];
    })
  );
}

export async function listRoleMatrix(): Promise<{
  permissions: typeof permissionDefinitions;
  rolePermissions: RolePermission[];
  roles: AccessRole[];
}> {
  const roles = await listRoles();
  const storedPermissions = await listStoredRolePermissions();
  const storedPermissionsByRoleKey = groupPermissionsByRoleKey(storedPermissions);

  const rolePermissions = roles.flatMap((role) => {
    const storedRolePermissions = storedPermissionsByRoleKey.get(role.key);

    if (storedRolePermissions?.length) {
      return completeRolePermissions(
        role.key,
        storedRolePermissions.map(({ action, resource, scope }) => ({
          action,
          resource,
          scope
        }))
      );
    }

    return completeRolePermissions(role.key, getDefaultRolePermissions(role.key));
  });

  return {
    permissions: permissionDefinitions,
    rolePermissions,
    roles
  };
}

export async function replaceRolePermissions(
  roleIdentifier: string,
  permissions: Array<{
    resource: PermissionResource;
    action: PermissionAction;
    scope: PermissionScope;
  }>
): Promise<RolePermission[]> {
  const role = await getRoleByIdentifier(roleIdentifier);

  if (!role) {
    throw new DashboardValidationError('Invalid role specified.');
  }

  const normalizedPermissions = completeRolePermissions(role.key, normalizeIncomingPermissions(permissions));

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM role_permissions
         WHERE role_key = $1`,
        [role.key]
      );

      for (const permission of normalizedPermissions) {
        await client.query(
          `INSERT INTO role_permissions (
             role_key,
             resource,
             action,
             scope
           )
           VALUES ($1, $2, $3, $4)`,
          [permission.roleKey, permission.resource, permission.action, permission.scope]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (isMissingRolePermissionsTableError(error)) {
      throw new DashboardValidationError(ROLE_PERMISSIONS_MIGRATION_REQUIRED_MESSAGE);
    }

    throw error;
  }

  return normalizedPermissions;
}

export async function resolvePermissionsForRoleName(roleName: string): Promise<ResolvedPermission[]> {
  const role = await getRoleByIdentifier(roleName);

  if (!role) {
    return normalizePermissionSet([]);
  }

  const storedPermissions = (await listStoredRolePermissions()).filter((permission) => permission.roleKey === role.key);

  if (!storedPermissions.length) {
    return getDefaultRolePermissions(role.key);
  }

  return normalizePermissionSet(
    storedPermissions.map(({ action, resource, scope }) => ({
      action,
      resource,
      scope
    }))
  );
}

export async function buildAccessContextForUser(input: {
  id: string;
  role: string;
}): Promise<AccessContext> {
  const role = await getRoleByIdentifier(input.role);

  return {
    userId: input.id,
    roleKey: role?.key ?? null,
    roleName: role?.name ?? input.role,
    userLocationIds: [],
    permissions: await resolvePermissionsForRoleName(input.role)
  };
}
