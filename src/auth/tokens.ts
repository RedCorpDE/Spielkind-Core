import crypto from 'node:crypto';
import { appConfig } from '../config.js';
import type { AdminAccessTokenPayload, AdminUser } from './types.js';

export class AdminAccessTokenError extends Error {}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function signToken(value: string): string {
  return crypto.createHmac('sha256', appConfig.ADMIN_ACCESS_TOKEN_SECRET).update(value).digest('base64url');
}

export function createAccessToken(user: AdminUser, sessionId: string): { token: string; expiresAt: string } {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowInSeconds + appConfig.ADMIN_ACCESS_TOKEN_TTL_MINUTES * 60;
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    type: 'access',
    sub: user.id,
    sid: sessionId,
    email: user.email,
    name: user.displayName,
    role: user.role,
    iat: nowInSeconds,
    exp: expiresAtSeconds
  } satisfies AdminAccessTokenPayload);
  const unsignedToken = `${header}.${payload}`;

  return {
    token: `${unsignedToken}.${signToken(unsignedToken)}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

export function verifyAccessToken(token: string): AdminAccessTokenPayload {
  const [header, payload, signature] = token.split('.');

  if (!header || !payload || !signature) {
    throw new AdminAccessTokenError('Malformed access token.');
  }

  const unsignedToken = `${header}.${payload}`;
  const expectedSignature = signToken(unsignedToken);
  const actualSignature = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    actualSignature.length !== expectedSignatureBuffer.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignatureBuffer)
  ) {
    throw new AdminAccessTokenError('Invalid access token signature.');
  }

  const decodedHeader = decodeJson(header);

  if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') {
    throw new AdminAccessTokenError('Unsupported access token format.');
  }

  const decodedPayload = decodeJson(payload);
  if (
    decodedPayload.type !== 'access' ||
    typeof decodedPayload.sub !== 'string' ||
    typeof decodedPayload.sid !== 'string' ||
    typeof decodedPayload.email !== 'string' ||
    typeof decodedPayload.name !== 'string' ||
    typeof decodedPayload.role !== 'string' ||
    typeof decodedPayload.iat !== 'number' ||
    typeof decodedPayload.exp !== 'number'
  ) {
    throw new AdminAccessTokenError('Invalid access token payload.');
  }

  const payloadValue: AdminAccessTokenPayload = {
    type: 'access',
    sub: decodedPayload.sub,
    sid: decodedPayload.sid,
    email: decodedPayload.email,
    name: decodedPayload.name,
    role: decodedPayload.role,
    iat: decodedPayload.iat,
    exp: decodedPayload.exp
  };

  if (payloadValue.exp <= Math.floor(Date.now() / 1000)) {
    throw new AdminAccessTokenError('Access token has expired.');
  }

  return payloadValue;
}

export function createRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
