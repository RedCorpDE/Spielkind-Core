import type { FastifyReply, FastifyRequest } from 'fastify';
import { findAuthenticatedClient } from '../client-api/auth.repository.js';
import { ClientAccessTokenError, verifyClientAccessToken } from '../client-api/tokens.js';
import type { AuthenticatedClient } from '../client-api/types.js';
import { appConfig } from '../config/env.js';
import { UnauthorizedHttpError } from './errors.js';

export type ClientFastifyRequest = FastifyRequest & { clientAuth?: AuthenticatedClient };

function bearerToken(request: FastifyRequest): string | null {
  const [scheme, token] = (request.headers.authorization ?? '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

export async function requireClientAuth(request: ClientFastifyRequest): Promise<AuthenticatedClient> {
  if (request.clientAuth) return request.clientAuth;
  const token = bearerToken(request);
  if (!token) throw new UnauthorizedHttpError('Missing bearer token.');

  try {
    const payload = verifyClientAccessToken(token);
    const auth = await findAuthenticatedClient(payload.sub, payload.sid);
    if (!auth) throw new UnauthorizedHttpError('Session is no longer valid.');
    request.clientAuth = auth;
    return auth;
  } catch (error) {
    if (error instanceof ClientAccessTokenError) throw new UnauthorizedHttpError(error.message);
    throw error;
  }
}

export function applyClientCors(request: FastifyRequest, reply: FastifyReply): boolean {
  const path = request.raw.url ?? request.url;
  if (!path.startsWith('/api/client')) return false;

  const origin = request.headers.origin;
  if (origin) {
    const allowed = appConfig.CLIENT_ALLOWED_ORIGIN.includes(origin) || appConfig.NODE_ENV !== 'production';
    if (!allowed) {
      reply.code(403).send({ message: 'Origin is not allowed.' });
      return true;
    }
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
  }
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
    return true;
  }
  return false;
}
