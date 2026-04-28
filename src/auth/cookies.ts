import type { Request, Response } from 'express';
import { appConfig } from '../config.js';

export function getRefreshCookieName(): string {
  return appConfig.ADMIN_REFRESH_COOKIE_NAME;
}

export function getCookie(req: Request, cookieName: string): string | null {
  const cookieHeader = req.header('cookie');

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

export function setRefreshTokenCookie(res: Response, refreshToken: string): void {
  res.cookie(getRefreshCookieName(), refreshToken, {
    httpOnly: true,
    secure: appConfig.NODE_ENV === 'production',
    sameSite: appConfig.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/api/admin/v1/auth',
    maxAge: appConfig.ADMIN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearRefreshTokenCookie(res: Response): void {
  res.clearCookie(getRefreshCookieName(), {
    httpOnly: true,
    secure: appConfig.NODE_ENV === 'production',
    sameSite: appConfig.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/api/admin/v1/auth'
  });
}

