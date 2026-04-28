import { Router } from 'express';
import { z } from 'zod';
import { appConfig } from '../config.js';
import {
  getAuthenticatedAdmin,
  getRequestMetadata,
  requireAdminAuth
} from './middleware.js';
import {
  createAdminSession,
  findAdminUserByEmail,
  findAuthenticatedAdminByRefreshToken,
  recordAdminAuditEvent,
  revokeAdminSession,
  rotateAdminSession,
  updateAdminLastLogin
} from './repository.js';
import { verifyPassword } from './password.js';
import { clearRefreshTokenCookie, getCookie, getRefreshCookieName, setRefreshTokenCookie } from './cookies.js';
import { createAccessToken, createRefreshToken } from './tokens.js';
import type { AdminAuthUser, AdminUser } from './types.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const loginAttempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil?: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function toAuthUser(user: AdminUser): AdminAuthUser {
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

function getLoginAttemptKey(email: string, ipAddress: string | null): string {
  return `${email.trim().toLowerCase()}|${ipAddress ?? 'unknown'}`;
}

function checkLoginAttemptLimit(key: string): string | null {
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

function recordFailedLogin(key: string): void {
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

function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}

function buildSessionExpiry(): string {
  return new Date(Date.now() + appConfig.ADMIN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function createAdminAuthRouter(): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const metadata = getRequestMetadata(req);

    try {
      const payload = loginSchema.parse(req.body);
      const loginAttemptKey = getLoginAttemptKey(payload.email, metadata.ipAddress);
      const blockedMessage = checkLoginAttemptLimit(loginAttemptKey);

      if (blockedMessage) {
        res.status(429).json({ error: blockedMessage });
        return;
      }

      const user = await findAdminUserByEmail(payload.email);
      const passwordMatches = await verifyPassword(payload.password, user?.passwordHash ?? null);

      if (!user || !passwordMatches || !user.isActive || !user.canAccessDashboard) {
        recordFailedLogin(loginAttemptKey);
        await recordAdminAuditEvent({
          action: 'auth.login.failed',
          details: { email: payload.email.trim().toLowerCase() },
          requestId: metadata.requestId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent
        });
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      clearFailedLogins(loginAttemptKey);

      const refreshToken = createRefreshToken();
      const session = await createAdminSession({
        userId: user.id,
        refreshToken,
        expiresAt: buildSessionExpiry(),
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
      });

      await updateAdminLastLogin(user.id);
      setRefreshTokenCookie(res, refreshToken);

      const authenticatedUser = { ...user, lastLoginAt: new Date().toISOString() };
      const accessToken = createAccessToken(authenticatedUser, session.sessionId);

      await recordAdminAuditEvent({
        actorUserId: user.id,
        action: 'auth.login.succeeded',
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
      });

      res.status(200).json({
        accessToken: accessToken.token,
        accessTokenExpiresAt: accessToken.expiresAt,
        user: toAuthUser(authenticatedUser)
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid login payload.', details: error.flatten() });
        return;
      }

      console.error('Admin login failed:', error);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  router.post('/refresh', async (req, res) => {
    try {
      const refreshToken = getCookie(req, getRefreshCookieName());

      if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token is missing.' });
        return;
      }

      const auth = await findAuthenticatedAdminByRefreshToken(refreshToken);

      if (!auth || !auth.user.isActive || !auth.user.canAccessDashboard) {
        clearRefreshTokenCookie(res);
        res.status(401).json({ error: 'Refresh token is invalid.' });
        return;
      }

      const nextRefreshToken = createRefreshToken();
      await rotateAdminSession({
        sessionId: auth.sessionId,
        refreshToken: nextRefreshToken,
        expiresAt: buildSessionExpiry(),
        userAgent: req.header('user-agent') ?? null
      });
      setRefreshTokenCookie(res, nextRefreshToken);

      const accessToken = createAccessToken(auth.user, auth.sessionId);

      res.status(200).json({
        accessToken: accessToken.token,
        accessTokenExpiresAt: accessToken.expiresAt,
        user: toAuthUser(auth.user)
      });
    } catch (error) {
      console.error('Admin refresh failed:', error);
      res.status(500).json({ error: 'Refresh failed.' });
    }
  });

  router.get('/me', requireAdminAuth, (req, res) => {
    try {
      const auth = getAuthenticatedAdmin(req);
      res.status(200).json({ user: toAuthUser(auth.user) });
    } catch (error) {
      console.error('Admin me route failed:', error);
      res.status(500).json({ error: 'Unable to load authenticated user.' });
    }
  });

  router.post('/logout', async (req, res) => {
    const metadata = getRequestMetadata(req);

    try {
      const refreshToken = getCookie(req, getRefreshCookieName());
      const auth =
        refreshToken ? await findAuthenticatedAdminByRefreshToken(refreshToken) : null;

      if (auth) {
        await revokeAdminSession(auth.sessionId);
        await recordAdminAuditEvent({
          actorUserId: auth.user.id,
          action: 'auth.logout',
          requestId: metadata.requestId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent
        });
      }

      clearRefreshTokenCookie(res);
      res.status(204).end();
    } catch (error) {
      console.error('Admin logout failed:', error);
      res.status(500).json({ error: 'Logout failed.' });
    }
  });

  return router;
}
