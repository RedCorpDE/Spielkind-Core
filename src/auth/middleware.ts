import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { appConfig } from '../config.js';
import { findAuthenticatedAdminBySession } from './repository.js';
import { AdminAccessTokenError, verifyAccessToken } from './tokens.js';
import type { AuthenticatedAdmin } from './types.js';

type RequestWithContext = Request & {
  auth?: AuthenticatedAdmin;
  requestId?: string;
};

export function attachRequestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header('x-request-id')?.trim() || randomUUID();
  (req as RequestWithContext).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

export function applyAdminCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');

  if (origin) {
    res.setHeader('Vary', 'Origin');

    if (!appConfig.DASHBOARD_ALLOWED_ORIGIN.includes(origin)) {
      res.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

function getBearerToken(req: Request): string | null {
  const authorization = req.header('authorization');

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bearerToken = getBearerToken(req);

  if (!bearerToken) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return;
  }

  try {
    const payload = verifyAccessToken(bearerToken);
    const auth = await findAuthenticatedAdminBySession(payload.sub, payload.sid);

    if (!auth || !auth.user.isActive || !auth.user.canAccessDashboard) {
      res.status(401).json({ error: 'Session is no longer valid.' });
      return;
    }

    (req as RequestWithContext).auth = auth;
    next();
  } catch (error) {
    if (error instanceof AdminAccessTokenError) {
      res.status(401).json({ error: error.message });
      return;
    }

    console.error('Admin auth middleware failed:', error);
    res.status(500).json({ error: 'Authentication failed.' });
  }
}

export function getAuthenticatedAdmin(req: Request): AuthenticatedAdmin {
  const auth = (req as RequestWithContext).auth;

  if (!auth) {
    throw new Error('Authenticated admin context is missing.');
  }

  return auth;
}

export function getRequestId(req: Request): string {
  return (req as RequestWithContext).requestId ?? 'unknown-request';
}

export function getClientIp(req: Request): string | null {
  const forwardedFor = req.header('x-forwarded-for');

  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return req.socket.remoteAddress ?? null;
}

export function getRequestMetadata(req: Request): {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    requestId: getRequestId(req),
    ipAddress: getClientIp(req),
    userAgent: req.header('user-agent') ?? null
  };
}
