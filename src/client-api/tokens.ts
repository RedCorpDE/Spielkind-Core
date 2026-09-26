import crypto from 'node:crypto';
import { appConfig } from '../config/env.js';
import type { ClientAccessTokenPayload } from './types.js';

export class ClientAccessTokenError extends Error {}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ClientAccessTokenError('Malformed access token.');
  }
}

function sign(value: string): string {
  return crypto.createHmac('sha256', appConfig.CLIENT_ACCESS_TOKEN_SECRET).update(value).digest('base64url');
}

export function createClientAccessToken(clientId: string, sessionId: string): { token: string; expiresAt: string } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + appConfig.CLIENT_ACCESS_TOKEN_TTL_MINUTES * 60;
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    type: 'client_access',
    sub: clientId,
    sid: sessionId,
    iat: issuedAt,
    exp: expiresAt
  } satisfies ClientAccessTokenPayload);
  const unsigned = `${header}.${payload}`;

  return {
    token: `${unsigned}.${sign(unsigned)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function verifyClientAccessToken(token: string): ClientAccessTokenPayload {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new ClientAccessTokenError('Malformed access token.');

  const unsigned = `${header}.${payload}`;
  const expected = Buffer.from(sign(unsigned));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ClientAccessTokenError('Invalid access token signature.');
  }

  const decodedHeader = decodeJson(header);
  const decoded = decodeJson(payload);
  if (
    decodedHeader.alg !== 'HS256' ||
    decodedHeader.typ !== 'JWT' ||
    decoded.type !== 'client_access' ||
    typeof decoded.sub !== 'string' ||
    typeof decoded.sid !== 'string' ||
    typeof decoded.iat !== 'number' ||
    typeof decoded.exp !== 'number'
  ) {
    throw new ClientAccessTokenError('Invalid access token payload.');
  }

  const value: ClientAccessTokenPayload = {
    type: 'client_access',
    sub: decoded.sub,
    sid: decoded.sid,
    iat: decoded.iat,
    exp: decoded.exp
  };
  if (value.exp <= Math.floor(Date.now() / 1000)) throw new ClientAccessTokenError('Access token has expired.');
  return value;
}

export function createOpaqueToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createVerificationCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashClientToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
