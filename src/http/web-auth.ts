import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { findAuthenticatedClient } from '../client-api/auth.repository.js';
import { ClientAccessTokenError, verifyClientAccessToken } from '../client-api/tokens.js';
import type { AuthenticatedClient } from '../client-api/types.js';
import { appConfig } from '../config/env.js';
import { ForbiddenHttpError, UnauthorizedHttpError } from './errors.js';

export const WEB_SERVICE_SCOPES = [
  'locations:read',
  'products:read',
  'availability:read',
  'checkout:create',
  'booking-status:read',
  'client-auth:proxy',
  'booking-management'
] as const;

export type WebServiceScope = (typeof WEB_SERVICE_SCOPES)[number];
export type WebFastifyRequest = FastifyRequest & {
  webServiceScopes?: ReadonlySet<WebServiceScope>;
  webClientAuth?: AuthenticatedClient;
};

function bearerValue(value: string | undefined): string | null {
  if (!value) return null;
  const [scheme, token] = value.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function configuredScopes(): ReadonlySet<WebServiceScope> {
  const allowed = new Set<string>(WEB_SERVICE_SCOPES);
  return new Set(
    appConfig.WORDPRESS_SERVICE_SCOPES.split(',')
      .map((scope) => scope.trim())
      .filter((scope): scope is WebServiceScope => allowed.has(scope))
  );
}

export async function requireWebServiceScope(
  request: WebFastifyRequest,
  scope: WebServiceScope
): Promise<void> {
  const token = bearerValue(request.headers.authorization);
  if (!token || !constantTimeEqual(token, appConfig.WORDPRESS_SERVICE_TOKEN)) {
    throw new UnauthorizedHttpError('Invalid WordPress service credentials.', 'AUTH_INVALID');
  }
  const scopes = request.webServiceScopes ?? configuredScopes();
  request.webServiceScopes = scopes;
  if (!scopes.has(scope)) {
    throw new ForbiddenHttpError(`WordPress service is missing the ${scope} scope.`, 'AUTH_INSUFFICIENT_SCOPE');
  }
}

export async function optionalWebClientAuth(request: WebFastifyRequest): Promise<AuthenticatedClient | null> {
  if (request.webClientAuth) return request.webClientAuth;
  const header = request.headers['x-client-authorization'];
  const token = bearerValue(typeof header === 'string' ? header : undefined);
  if (!token) return null;
  try {
    const payload = verifyClientAccessToken(token);
    const auth = await findAuthenticatedClient(payload.sub, payload.sid);
    if (!auth) throw new UnauthorizedHttpError('Client session is no longer valid.', 'AUTH_INVALID');
    request.webClientAuth = auth;
    return auth;
  } catch (error) {
    if (error instanceof ClientAccessTokenError) {
      throw new UnauthorizedHttpError(error.message, 'AUTH_INVALID');
    }
    throw error;
  }
}

export async function requireWebClientAuth(request: WebFastifyRequest): Promise<AuthenticatedClient> {
  const auth = await optionalWebClientAuth(request);
  if (!auth) throw new UnauthorizedHttpError('Client authentication is required.', 'AUTH_REQUIRED');
  return auth;
}
