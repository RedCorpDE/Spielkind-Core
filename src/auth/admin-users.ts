import { pool } from '../db/client.js';
import { hashPassword } from './password.js';
import type { AdminUser } from './types.js';

interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  can_access_dashboard: boolean;
  password_hash: string | null;
  last_login_at: Date | string | null;
}

export class AdminUserManagementError extends Error {}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value instanceof Date ? value : new Date(value);
  return Number.isNaN(normalized.getTime()) ? null : normalized.toISOString();
}

function mapAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    canAccessDashboard: row.can_access_dashboard,
    passwordHash: row.password_hash,
    lastLoginAt: toIsoString(row.last_login_at)
  };
}

function isDatabaseError(error: unknown): error is { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null;
}

function throwAdminUserMutationError(error: unknown): never {
  if (isDatabaseError(error)) {
    if (error.code === '23505') {
      throw new AdminUserManagementError('A user with this email already exists.');
    }
  }

  throw error;
}

async function revokeAdminSessionsByUserId(userId: string): Promise<void> {
  await pool.query(
    `UPDATE admin_sessions
     SET revoked_at = now()
     WHERE user_id = $1
       AND revoked_at IS NULL`,
    [userId]
  );
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const result = await pool.query<AdminUserRow>(
    `SELECT
       id,
       email,
       display_name,
       role,
       is_active,
       can_access_dashboard,
       password_hash,
       last_login_at
     FROM users
     ORDER BY display_name ASC, email ASC`
  );

  return result.rows.map(mapAdminUser);
}

export async function getAdminUserById(userId: string): Promise<AdminUser | null> {
  const result = await pool.query<AdminUserRow>(
    `SELECT
       id,
       email,
       display_name,
       role,
       is_active,
       can_access_dashboard,
       password_hash,
       last_login_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  return result.rowCount ? mapAdminUser(result.rows[0]) : null;
}

export async function createAdminUser(input: {
  email: string;
  displayName: string;
  role: string;
  password: string;
  canAccessDashboard: boolean;
  isActive: boolean;
}): Promise<AdminUser> {
  try {
    const passwordHash = await hashPassword(input.password);
    const result = await pool.query<AdminUserRow>(
      `INSERT INTO users (
         email,
         display_name,
         role,
         is_active,
         can_access_dashboard,
         password_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
         id,
         email,
         display_name,
         role,
         is_active,
         can_access_dashboard,
         password_hash,
         last_login_at`,
      [
        input.email.trim().toLowerCase(),
        input.displayName.trim(),
        input.role.trim(),
        input.isActive,
        input.canAccessDashboard,
        passwordHash
      ]
    );

    return mapAdminUser(result.rows[0]);
  } catch (error) {
    throwAdminUserMutationError(error);
  }
}

export async function updateAdminUser(
  userId: string,
  input: {
    email?: string;
    displayName?: string;
    role?: string;
    password?: string;
    canAccessDashboard?: boolean;
    isActive?: boolean;
  }
): Promise<AdminUser | null> {
  const existing = await getAdminUserById(userId);
  if (!existing) {
    return null;
  }

  const nextEmail = typeof input.email === 'string' ? input.email.trim().toLowerCase() : existing.email;
  const nextDisplayName = typeof input.displayName === 'string' ? input.displayName.trim() : existing.displayName;
  const nextRole = typeof input.role === 'string' ? input.role.trim() : existing.role;
  const nextCanAccessDashboard =
    typeof input.canAccessDashboard === 'boolean' ? input.canAccessDashboard : existing.canAccessDashboard;
  const nextIsActive = typeof input.isActive === 'boolean' ? input.isActive : existing.isActive;
  const nextPasswordHash = input.password !== undefined ? await hashPassword(input.password) : existing.passwordHash;

  try {
    const result = await pool.query<AdminUserRow>(
      `UPDATE users
       SET
         email = $1,
         display_name = $2,
         role = $3,
         is_active = $4,
         can_access_dashboard = $5,
         password_hash = $6
       WHERE id = $7
       RETURNING
         id,
         email,
         display_name,
         role,
         is_active,
         can_access_dashboard,
         password_hash,
         last_login_at`,
      [nextEmail, nextDisplayName, nextRole, nextIsActive, nextCanAccessDashboard, nextPasswordHash, userId]
    );

    if (!result.rowCount) {
      return null;
    }

    if (
      nextEmail !== existing.email ||
      nextRole !== existing.role ||
      nextCanAccessDashboard !== existing.canAccessDashboard ||
      nextIsActive !== existing.isActive ||
      input.password !== undefined
    ) {
      await revokeAdminSessionsByUserId(userId);
    }

    return mapAdminUser(result.rows[0]);
  } catch (error) {
    throwAdminUserMutationError(error);
  }
}
