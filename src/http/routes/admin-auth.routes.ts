import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appConfig } from '../../config/env.js';
import {
  createAdminSession,
  findAdminUserByEmail,
  findAuthenticatedAdminByRefreshToken,
  recordAdminAuditEvent,
  revokeAdminSession,
  rotateAdminSession,
  updateAdminLastLogin
} from '../../auth/repository.js';
import { verifyPassword } from '../../auth/password.js';
import { createAccessToken, createRefreshToken } from '../../auth/tokens.js';
import {
  checkLoginAttemptLimit,
  clearFailedLogins,
  getLoginAttemptKey,
  getRefreshTokenFromRequest,
  getRequestMetadata,
  recordFailedLogin,
  requireAdminAuth,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  toAuthUser,
  type AdminFastifyRequest
} from '../admin.js';
import { ValidationHttpError } from '../errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

function buildSessionExpiry(): string {
  return new Date(Date.now() + appConfig.ADMIN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid login payload.');
    }

    const metadata = getRequestMetadata(request);
    const loginAttemptKey = getLoginAttemptKey(parsed.data.email, metadata.ipAddress);
    const blockedMessage = checkLoginAttemptLimit(loginAttemptKey);

    if (blockedMessage) {
      reply.code(429);
      return { ok: false, error: blockedMessage };
    }

    const user = await findAdminUserByEmail(parsed.data.email);
    const passwordMatches = await verifyPassword(parsed.data.password, user?.passwordHash ?? null);

    if (!user || !passwordMatches || !user.isActive || !user.canAccessDashboard) {
      recordFailedLogin(loginAttemptKey);
      await recordAdminAuditEvent({
        action: 'auth.login.failed',
        details: { email: parsed.data.email.trim().toLowerCase() },
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
      });
      reply.code(401);
      return { ok: false, error: 'Invalid email or password.' };
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
    setRefreshTokenCookie(reply, refreshToken);

    const authenticatedUser = { ...user, lastLoginAt: new Date().toISOString() };
    const accessToken = createAccessToken(authenticatedUser, session.sessionId);

    await recordAdminAuditEvent({
      actorUserId: user.id,
      action: 'auth.login.succeeded',
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent
    });

    return {
      ok: true,
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      user: toAuthUser(authenticatedUser)
    };
  });

  app.post('/api/admin/auth/refresh', async (request, reply) => {
    const refreshToken = getRefreshTokenFromRequest(request);
    if (!refreshToken) {
      reply.code(401);
      return { ok: false, error: 'Refresh token is missing.' };
    }

    const auth = await findAuthenticatedAdminByRefreshToken(refreshToken);
    if (!auth || !auth.user.isActive || !auth.user.canAccessDashboard) {
      clearRefreshTokenCookie(reply);
      reply.code(401);
      return { ok: false, error: 'Refresh token is invalid.' };
    }

    const nextRefreshToken = createRefreshToken();
    await rotateAdminSession({
      sessionId: auth.sessionId,
      refreshToken: nextRefreshToken,
      expiresAt: buildSessionExpiry(),
      userAgent: request.headers['user-agent'] ?? null
    });
    setRefreshTokenCookie(reply, nextRefreshToken);

    const accessToken = createAccessToken(auth.user, auth.sessionId);
    return {
      ok: true,
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      user: toAuthUser(auth.user)
    };
  });

  app.get('/api/admin/auth/me', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    return { ok: true, user: toAuthUser(auth.user) };
  });

  app.post('/api/admin/auth/logout', async (request, reply) => {
    const metadata = getRequestMetadata(request);
    const refreshToken = getRefreshTokenFromRequest(request);
    const auth = refreshToken ? await findAuthenticatedAdminByRefreshToken(refreshToken) : null;

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

    clearRefreshTokenCookie(reply);
    reply.code(204);
    return reply.send();
  });
}
