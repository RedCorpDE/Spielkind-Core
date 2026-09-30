import { createHmac, timingSafeEqual } from 'node:crypto';
import { appConfig } from '../../config/env.js';

export interface WebAvailabilityTokenPayload {
  locationId: string;
  productId: string;
  locationProductId?: string;
  variantId: string | null;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
}

function signature(payload: string): string {
  return createHmac('sha256', appConfig.CLIENT_ACCESS_TOKEN_SECRET).update(`web-availability:${payload}`).digest('base64url');
}

export function createAvailabilityToken(value: WebAvailabilityTokenPayload): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyAvailabilityToken(token: string): WebAvailabilityTokenPayload | null {
  const [payload, actual] = token.split('.');
  if (!payload || !actual) return null;
  const expected = Buffer.from(signature(payload));
  const received = Buffer.from(actual);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WebAvailabilityTokenPayload;
    if (!value.locationId || !value.productId || !value.startsAt || !value.endsAt) return null;
    if (new Date(value.expiresAt).getTime() <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}
