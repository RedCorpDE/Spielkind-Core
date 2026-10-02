import { createHash, randomBytes } from 'node:crypto';
import { appConfig } from '../../config/env.js';
import { pool } from '../../db/pool.js';

export function hashWebToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function opaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

export async function createCheckoutToken(
  bookingId: string,
  expiresAt: string,
  authenticatedClientId: string | null = null
): Promise<string> {
  const token = opaqueToken();
  await pool.query(
    `INSERT INTO booking_checkout_sessions (booking_id, token_hash, expires_at, authenticated_client_id)
     VALUES ($1, $2, $3, $4)`,
    [bookingId, hashWebToken(token), expiresAt, authenticatedClientId]
  );
  return token;
}

export async function validateCheckoutToken(
  bookingId: string,
  token: string
): Promise<{ authenticatedClientId: string | null } | null> {
  const result = await pool.query<{ authenticated_client_id: string | null }>(
    `SELECT authenticated_client_id FROM booking_checkout_sessions
     WHERE booking_id = $1 AND token_hash = $2 AND expires_at > now() LIMIT 1`,
    [bookingId, hashWebToken(token)]
  );
  return result.rowCount
    ? { authenticatedClientId: result.rows[0].authenticated_client_id }
    : null;
}

export async function createManagementToken(bookingId: string): Promise<string> {
  const token = opaqueToken();
  await pool.query(
    `INSERT INTO booking_management_tokens (booking_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' days')::interval)`,
    [bookingId, hashWebToken(token), appConfig.WEB_MANAGEMENT_TOKEN_TTL_DAYS]
  );
  return token;
}

export async function bookingForManagementToken(token: string): Promise<string | null> {
  const result = await pool.query<{ booking_id: string }>(
    `SELECT booking_id FROM booking_management_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [hashWebToken(token)]
  );
  return result.rows[0]?.booking_id ?? null;
}

export async function ensureManagementToken(bookingId: string): Promise<string> {
  // Raw management tokens are deliberately never stored, so a fresh token is issued
  // only after payment confirmation/status access proves possession of checkout auth.
  return createManagementToken(bookingId);
}

