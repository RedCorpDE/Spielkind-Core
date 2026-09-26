import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { appConfig } from '../config/env.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { createOpaqueToken, createVerificationCode, hashClientToken } from './tokens.js';
import type { AuthenticatedClient, ClientProfile } from './types.js';

interface ClientAuthRow {
  client_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  phone_number: string | null;
  avatar_url: string | null;
  email_verified_at: string | null;
  onboarding_completed_at: string | null;
  identity_id: string;
  password_hash: string | null;
}

const clientAuthColumns = `
  c.client_id,
  c.first_name,
  c.last_name,
  COALESCE(c.display_name, NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.first_name) AS display_name,
  c.email::text AS email,
  c.phone_number,
  c.avatar_url,
  identity.email_verified_at,
  preferences.onboarding_completed_at,
  identity.id AS identity_id,
  identity.password_hash`;

const clientAuthFrom = `FROM clients c
INNER JOIN client_auth_identities identity
  ON identity.client_id = c.client_id AND identity.provider = 'password'
LEFT JOIN client_preferences preferences ON preferences.client_id = c.client_id`;

function mapClient(row: ClientAuthRow): ClientProfile {
  return {
    id: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    emailVerified: Boolean(row.email_verified_at),
    onboardingCompleted: Boolean(row.onboarding_completed_at),
    avatarUrl: row.avatar_url,
    phone: row.phone_number
  };
}

function sessionExpiresAt(): string {
  return new Date(Date.now() + appConfig.CLIENT_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function validateClientPassword(password: string): void {
  if (password.length < appConfig.CLIENT_PASSWORD_MIN_LENGTH || password.length > 128) {
    throw new Error(
      `Password must be between ${appConfig.CLIENT_PASSWORD_MIN_LENGTH} and 128 characters long.`
    );
  }
}

export async function hashClientPassword(password: string): Promise<string> {
  validateClientPassword(password);
  return bcrypt.hash(password, 12);
}

export async function findClientLogin(email: string): Promise<(ClientProfile & { identityId: string; passwordHash: string | null }) | null> {
  const result = await pool.query<ClientAuthRow>(
    `SELECT ${clientAuthColumns}
     ${clientAuthFrom}
     WHERE LOWER(identity.email) = LOWER($1)
     LIMIT 1`,
    [email.trim()]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { ...mapClient(row), identityId: row.identity_id, passwordHash: row.password_hash };
}

export async function registerClient(input: {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  password: string;
}): Promise<{ client: ClientProfile; identityId: string; verificationCode: string }> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const passwordHash = await hashClientPassword(input.password);
  const verificationCode = createVerificationCode();

  return withTransaction(async (client) => {
    const inserted = await client.query<{ client_id: string }>(
      `INSERT INTO clients (first_name, last_name, display_name, email)
       VALUES ($1, $2, $3, $4)
       RETURNING client_id`,
      [input.firstName.trim(), input.lastName.trim(), input.displayName.trim(), normalizedEmail]
    );
    const clientId = inserted.rows[0].client_id;
    const identity = await client.query<{ id: string }>(
      `INSERT INTO client_auth_identities (client_id, provider, provider_subject, email, password_hash)
       VALUES ($1, 'password', $2, $2, $3)
       RETURNING id`,
      [clientId, normalizedEmail, passwordHash]
    );
    await client.query(`INSERT INTO client_preferences (client_id) VALUES ($1)`, [clientId]);
    await createEmailVerification(client, clientId, identity.rows[0].id, normalizedEmail, verificationCode);

    return {
      client: {
        id: clientId,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        displayName: input.displayName.trim(),
        email: normalizedEmail,
        emailVerified: false,
        onboardingCompleted: false,
        avatarUrl: null,
        phone: null
      },
      identityId: identity.rows[0].id,
      verificationCode
    };
  });
}

async function createEmailVerification(
  client: PoolClient,
  clientId: string,
  identityId: string,
  email: string,
  code: string
): Promise<void> {
  await client.query(
    `UPDATE client_email_verifications
     SET consumed_at = NOW()
     WHERE client_id = $1 AND consumed_at IS NULL`,
    [clientId]
  );
  await client.query(
    `INSERT INTO client_email_verifications (client_id, auth_identity_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 minutes')`,
    [clientId, identityId, email, hashClientToken(code)]
  );
}

export async function issueEmailVerification(clientId: string): Promise<string | null> {
  const auth = await pool.query<{ identity_id: string; email: string; email_verified_at: string | null }>(
    `SELECT id AS identity_id, email, email_verified_at
     FROM client_auth_identities
     WHERE client_id = $1 AND provider = 'password'
     LIMIT 1`,
    [clientId]
  );
  const row = auth.rows[0];
  if (!row || row.email_verified_at) return null;
  const code = createVerificationCode();
  await withTransaction((client) => createEmailVerification(client, clientId, row.identity_id, row.email, code));
  return code;
}

export async function consumeEmailVerification(clientId: string, code: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; auth_identity_id: string }>(
      `SELECT id, auth_identity_id
       FROM client_email_verifications
       WHERE client_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [clientId, hashClientToken(code)]
    );
    if (!result.rowCount) return false;
    await client.query(`UPDATE client_email_verifications SET consumed_at = NOW() WHERE id = $1`, [result.rows[0].id]);
    await client.query(
      `UPDATE client_auth_identities SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [result.rows[0].auth_identity_id]
    );
    return true;
  });
}

export async function createClientSession(input: {
  clientId: string;
  identityId: string | null;
  refreshToken: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO client_sessions (
       client_id, auth_identity_id, refresh_token_hash, ip_address, user_agent, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4::inet, $5, $6, NOW())
     RETURNING id`,
    [
      input.clientId,
      input.identityId,
      hashClientToken(input.refreshToken),
      input.ipAddress,
      input.userAgent,
      sessionExpiresAt()
    ]
  );
  return result.rows[0].id;
}

export async function rotateClientSession(refreshToken: string, nextRefreshToken: string): Promise<AuthenticatedClient | null> {
  return withTransaction(async (client) => {
    const result = await client.query<ClientAuthRow & { session_id: string }>(
      `SELECT ${clientAuthColumns}, session.id AS session_id
       ${clientAuthFrom}
       INNER JOIN client_sessions session ON session.client_id = c.client_id
       WHERE session.refresh_token_hash = $1
         AND session.revoked_at IS NULL
         AND session.expires_at > NOW()
       LIMIT 1
       FOR UPDATE OF session`,
      [hashClientToken(refreshToken)]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    await client.query(
      `UPDATE client_sessions
       SET refresh_token_hash = $1, expires_at = $2, last_used_at = NOW()
       WHERE id = $3`,
      [hashClientToken(nextRefreshToken), sessionExpiresAt(), row.session_id]
    );
    return { sessionId: row.session_id, client: mapClient(row) };
  });
}

export async function findAuthenticatedClient(clientId: string, sessionId: string): Promise<AuthenticatedClient | null> {
  const result = await pool.query<ClientAuthRow & { session_id: string }>(
    `SELECT ${clientAuthColumns}, session.id AS session_id
     ${clientAuthFrom}
     INNER JOIN client_sessions session ON session.client_id = c.client_id
     WHERE c.client_id = $1 AND session.id = $2
       AND session.revoked_at IS NULL AND session.expires_at > NOW()
     LIMIT 1`,
    [clientId, sessionId]
  );
  if (!result.rowCount) return null;
  return { sessionId: result.rows[0].session_id, client: mapClient(result.rows[0]) };
}

export async function revokeClientSession(sessionId: string): Promise<void> {
  await pool.query(`UPDATE client_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

export async function requestPasswordReset(email: string): Promise<string | null> {
  const auth = await findClientLogin(email);
  if (!auth) return null;
  const token = createOpaqueToken();
  await pool.query(
    `INSERT INTO client_password_reset_tokens (client_id, auth_identity_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [auth.id, auth.identityId, hashClientToken(token)]
  );
  return token;
}

export async function resetClientPassword(token: string, password: string): Promise<boolean> {
  const passwordHash = await hashClientPassword(password);
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; client_id: string; auth_identity_id: string }>(
      `SELECT id, client_id, auth_identity_id
       FROM client_password_reset_tokens
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
       LIMIT 1 FOR UPDATE`,
      [hashClientToken(token)]
    );
    if (!result.rowCount) return false;
    const row = result.rows[0];
    await client.query(`UPDATE client_auth_identities SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
      passwordHash,
      row.auth_identity_id
    ]);
    await client.query(`UPDATE client_password_reset_tokens SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    await client.query(`UPDATE client_sessions SET revoked_at = NOW() WHERE client_id = $1 AND revoked_at IS NULL`, [
      row.client_id
    ]);
    return true;
  });
}
