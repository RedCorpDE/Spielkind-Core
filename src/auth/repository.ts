import { pool } from '../db/client.js';
import { assertRoleExists } from '../dashboard/repository/roles.js';
import type { AdminAuditEvent, AdminUser, AuthenticatedAdmin } from './types.js';
import { hashRefreshToken } from './tokens.js';

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

interface AdminSessionRow {
  session_id: string;
  session_expires_at: Date | string;
  session_revoked_at: Date | string | null;
  session_last_used_at: Date | string;
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  can_access_dashboard: boolean;
  password_hash: string | null;
  last_login_at: Date | string | null;
}

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

function mapAuthenticatedAdmin(row: AdminSessionRow): AuthenticatedAdmin {
  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
      canAccessDashboard: row.can_access_dashboard,
      passwordHash: row.password_hash,
      lastLoginAt: toIsoString(row.last_login_at)
    }
  };
}

export async function findAdminUserByEmail(email: string): Promise<AdminUser | null> {
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
     WHERE email = $1
     LIMIT 1`,
    [email.trim().toLowerCase()]
  );

  return result.rowCount ? mapAdminUser(result.rows[0]) : null;
}

export async function createAdminSession(input: {
  userId: string;
  refreshToken: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ sessionId: string; expiresAt: string }> {
  const result = await pool.query<{ id: string; expires_at: Date | string }>(
    `INSERT INTO admin_sessions (
       user_id,
       token_hash,
       expires_at,
       created_ip,
       user_agent
     )
     VALUES ($1, $2, $3::timestamptz, $4, $5)
     RETURNING id, expires_at`,
    [
      input.userId,
      hashRefreshToken(input.refreshToken),
      input.expiresAt,
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );

  return {
    sessionId: result.rows[0].id,
    expiresAt: new Date(result.rows[0].expires_at).toISOString()
  };
}

export async function findAuthenticatedAdminByRefreshToken(
  refreshToken: string
): Promise<AuthenticatedAdmin | null> {
  const result = await pool.query<AdminSessionRow>(
    `SELECT
       s.id AS session_id,
       s.expires_at AS session_expires_at,
       s.revoked_at AS session_revoked_at,
       s.last_used_at AS session_last_used_at,
       u.id AS user_id,
       u.email,
       u.display_name,
       u.role,
       u.is_active,
       u.can_access_dashboard,
       u.password_hash,
       u.last_login_at
     FROM admin_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     LIMIT 1`,
    [hashRefreshToken(refreshToken)]
  );

  if (!result.rowCount) {
    return null;
  }

  return mapAuthenticatedAdmin(result.rows[0]);
}

export async function findAuthenticatedAdminBySession(
  userId: string,
  sessionId: string
): Promise<AuthenticatedAdmin | null> {
  const result = await pool.query<AdminSessionRow>(
    `SELECT
       s.id AS session_id,
       s.expires_at AS session_expires_at,
       s.revoked_at AS session_revoked_at,
       s.last_used_at AS session_last_used_at,
       u.id AS user_id,
       u.email,
       u.display_name,
       u.role,
       u.is_active,
       u.can_access_dashboard,
       u.password_hash,
       u.last_login_at
     FROM admin_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND u.id = $2
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     LIMIT 1`,
    [sessionId, userId]
  );

  if (!result.rowCount) {
    return null;
  }

  return mapAuthenticatedAdmin(result.rows[0]);
}

export async function rotateAdminSession(input: {
  sessionId: string;
  refreshToken: string;
  expiresAt: string;
  userAgent?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE admin_sessions
     SET
       token_hash = $1,
       expires_at = $2::timestamptz,
       last_used_at = now(),
       user_agent = COALESCE($3, user_agent)
     WHERE id = $4`,
    [hashRefreshToken(input.refreshToken), input.expiresAt, input.userAgent ?? null, input.sessionId]
  );
}

export async function revokeAdminSession(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE admin_sessions
     SET revoked_at = now()
     WHERE id = $1
       AND revoked_at IS NULL`,
    [sessionId]
  );
}

export async function updateAdminLastLogin(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users
     SET last_login_at = now()
     WHERE id = $1`,
    [userId]
  );
}

export async function recordAdminAuditEvent(event: AdminAuditEvent): Promise<void> {
  await pool.query(
    `INSERT INTO admin_audit_log (
       actor_user_id,
       action,
       entity_type,
       entity_id,
       details,
       request_id,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.actorUserId ?? null,
      event.action,
      event.entityType ?? null,
      event.entityId ?? null,
      event.details ?? {},
      event.requestId ?? null,
      event.ipAddress ?? null,
      event.userAgent ?? null
    ]
  );
}

export async function upsertAdminUser(input: {
  email: string;
  displayName: string;
  role: string;
  passwordHash: string;
  canAccessDashboard: boolean;
}): Promise<AdminUser> {
  const normalizedRole = await assertRoleExists(input.role);
  const result = await pool.query<AdminUserRow>(
    `INSERT INTO users (
       email,
       display_name,
       role,
       password_hash,
       can_access_dashboard
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       password_hash = EXCLUDED.password_hash,
       can_access_dashboard = EXCLUDED.can_access_dashboard,
       is_active = true
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
      normalizedRole,
      input.passwordHash,
      input.canAccessDashboard
    ]
  );

  return mapAdminUser(result.rows[0]);
}
