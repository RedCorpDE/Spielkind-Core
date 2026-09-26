import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  consumeEmailVerification,
  createClientSession,
  findClientLogin,
  issueEmailVerification,
  registerClient,
  requestPasswordReset,
  resetClientPassword,
  revokeClientSession,
  rotateClientSession
} from '../../client-api/auth.repository.js';
import { createClientAccessToken, createOpaqueToken } from '../../client-api/tokens.js';
import type { ClientProfile } from '../../client-api/types.js';
import { getRequestMetadata } from '../admin.js';
import { requireClientAuth, type ClientFastifyRequest } from '../client.js';
import { ConflictHttpError, UnauthorizedHttpError, ValidationHttpError } from '../errors.js';

const email = z.string().trim().email().transform((value) => value.toLowerCase());
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(2).max(100),
  email,
  password: z.string().min(8).max(128)
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const forgotPasswordSchema = z.object({ email });
const resetPasswordSchema = z.object({ token: z.string().min(1), password: z.string().min(8).max(128) });
const verifyEmailSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function sessionResponse(client: ClientProfile, sessionId: string, refreshToken: string) {
  const access = createClientAccessToken(client.id, sessionId);
  return { accessToken: access.token, refreshToken, expiresAt: access.expiresAt, client };
}

export async function registerClientAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/client/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid registration payload.');

    try {
      const registered = await registerClient(parsed.data);
      const refreshToken = createOpaqueToken();
      const metadata = getRequestMetadata(request);
      const sessionId = await createClientSession({
        clientId: registered.client.id,
        identityId: registered.identityId,
        refreshToken,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
      });
      request.log.debug({ clientId: registered.client.id }, 'Client registration created; email verification pending');
      reply.code(201);
      return sessionResponse(registered.client, sessionId, refreshToken);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictHttpError('An account with this email already exists.');
      if (error instanceof Error && error.message.startsWith('Password must')) {
        throw new ValidationHttpError(error.message);
      }
      throw error;
    }
  });

  app.post('/api/client/auth/login', async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid login payload.');
    const client = await findClientLogin(parsed.data.email);
    const matches = client?.passwordHash ? await bcrypt.compare(parsed.data.password, client.passwordHash) : false;
    if (!client || !matches) throw new UnauthorizedHttpError('Invalid email or password.');

    const refreshToken = createOpaqueToken();
    const metadata = getRequestMetadata(request);
    const sessionId = await createClientSession({
      clientId: client.id,
      identityId: client.identityId,
      refreshToken,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent
    });
    const { identityId: _identityId, passwordHash: _passwordHash, ...profile } = client;
    return sessionResponse(profile, sessionId, refreshToken);
  });

  app.post('/api/client/auth/refresh', async (request) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) throw new UnauthorizedHttpError('Refresh token is missing.');
    const nextRefreshToken = createOpaqueToken();
    const auth = await rotateClientSession(parsed.data.refreshToken, nextRefreshToken);
    if (!auth) throw new UnauthorizedHttpError('Refresh token is invalid.');
    return sessionResponse(auth.client, auth.sessionId, nextRefreshToken);
  });

  app.post('/api/client/auth/logout', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    await revokeClientSession(auth.sessionId);
    reply.code(204);
    return reply.send();
  });

  app.post('/api/client/auth/forgot-password', async (request) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid email address.');
    await requestPasswordReset(parsed.data.email);
    return { accepted: true };
  });

  app.post('/api/client/auth/reset-password', async (request) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid password reset payload.');
    try {
      if (!(await resetClientPassword(parsed.data.token, parsed.data.password))) {
        throw new ValidationHttpError('This password reset link is invalid or expired.');
      }
      return { accepted: true };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Password must')) {
        throw new ValidationHttpError(error.message);
      }
      throw error;
    }
  });

  app.post('/api/client/auth/verify-email', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const parsed = verifyEmailSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Enter the six-digit verification code.');
    if (!(await consumeEmailVerification(auth.client.id, parsed.data.code))) {
      throw new ValidationHttpError('The verification code is invalid or expired.');
    }
    return { accepted: true };
  });

  app.post('/api/client/auth/resend-verification', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    await issueEmailVerification(auth.client.id);
    return { accepted: true };
  });
}
