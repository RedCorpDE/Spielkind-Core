import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccessContext } from '../access-control/model.js';
import { appConfig } from '../config/env.js';
import { findAuthenticatedAdminBySession } from '../auth/repository.js';
import { AdminAccessTokenError, verifyAccessToken } from '../auth/tokens.js';
import type { AdminAuthUser, AuthenticatedAdmin } from '../auth/types.js';
import { UnauthorizedHttpError } from './errors.js';

export type AdminFastifyRequest = FastifyRequest & {
  adminAuth?: AuthenticatedAdmin;
  adminAccessContext?: AccessContext;
};

const loginAttempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil?: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function parseCookieHeader(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === cookieName) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}

function buildCookieAttributes(maxAgeMs?: number): string[] {
  const attributes = [
    `Path=/api/admin`,
    'HttpOnly',
    appConfig.NODE_ENV === 'production' ? 'SameSite=None' : 'SameSite=Lax'
  ];

  if (appConfig.NODE_ENV === 'production') {
    attributes.push('Secure');
  }

  if (typeof maxAgeMs === 'number') {
    attributes.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }

  return attributes;
}

export function setRefreshTokenCookie(reply: FastifyReply, refreshToken: string): void {
  const value = `${appConfig.ADMIN_REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; ${buildCookieAttributes(
    appConfig.ADMIN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  ).join('; ')}`;
  reply.header('set-cookie', value);
}

export function clearRefreshTokenCookie(reply: FastifyReply): void {
  const value = `${appConfig.ADMIN_REFRESH_COOKIE_NAME}=; ${[
    ...buildCookieAttributes(0),
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ].join('; ')}`;
  reply.header('set-cookie', value);
}

export function getRefreshTokenFromRequest(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  return parseCookieHeader(cookieHeader, appConfig.ADMIN_REFRESH_COOKIE_NAME);
}

export function applyAdminCors(request: FastifyRequest, reply: FastifyReply): boolean {
  const path = request.raw.url ?? request.url;
  if (!path.startsWith('/api/admin')) {
    return false;
  }

  const origin = request.headers.origin;
  if (origin) {
    reply.header('Vary', 'Origin');

    if (!appConfig.DASHBOARD_ALLOWED_ORIGIN.includes(origin)) {
      reply.code(403).send({ ok: false, error: 'Origin is not allowed.' });
      return true;
    }

    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
  }

  if (request.method === 'OPTIONS') {
    reply.code(204).send();
    return true;
  }

  return false;
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

export async function requireAdminAuth(request: AdminFastifyRequest): Promise<AuthenticatedAdmin> {
  if (request.adminAuth) {
    return request.adminAuth;
  }

  const token = getBearerToken(request);
  if (!token) {
    throw new UnauthorizedHttpError('Missing bearer token.');
  }

  try {
    const payload = verifyAccessToken(token);
    const auth = await findAuthenticatedAdminBySession(payload.sub, payload.sid);

    if (!auth || !auth.user.isActive || !auth.user.canAccessDashboard) {
      throw new UnauthorizedHttpError('Session is no longer valid.');
    }

    request.adminAuth = auth;
    return auth;
  } catch (error) {
    if (error instanceof AdminAccessTokenError) {
      throw new UnauthorizedHttpError(error.message);
    }

    throw error;
  }
}

export function getRequestMetadata(request: FastifyRequest): {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
} {
  const forwardedFor = request.headers['x-forwarded-for'];
  const ipAddress = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() ?? null : request.ip ?? null;

  return {
    requestId: request.id,
    ipAddress,
    userAgent: request.headers['user-agent'] ?? null
  };
}

export function toAuthUser(user: AuthenticatedAdmin['user']): AdminAuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    canAccessDashboard: user.canAccessDashboard,
    lastLoginAt: user.lastLoginAt
  };
}

export function getLoginAttemptKey(email: string, ipAddress: string | null): string {
  return `${email.trim().toLowerCase()}|${ipAddress ?? 'unknown'}`;
}

export function checkLoginAttemptLimit(key: string): string | null {
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (!attempt) {
    return null;
  }

  if (attempt.blockedUntil && attempt.blockedUntil > now) {
    return 'Too many failed login attempts. Try again later.';
  }

  if (attempt.windowStartedAt + LOGIN_WINDOW_MS <= now) {
    loginAttempts.delete(key);
    return null;
  }

  return null;
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (!attempt || attempt.windowStartedAt + LOGIN_WINDOW_MS <= now) {
    loginAttempts.set(key, { count: 1, windowStartedAt: now });
    return;
  }

  const nextAttempt = { ...attempt, count: attempt.count + 1 };
  if (nextAttempt.count >= LOGIN_MAX_ATTEMPTS) {
    nextAttempt.blockedUntil = now + LOGIN_BLOCK_MS;
  }

  loginAttempts.set(key, nextAttempt);
}

export function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}
