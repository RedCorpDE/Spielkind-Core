import type { FastifyInstance } from 'fastify';
import { appConfig } from '../../config/env.js';
import { checkDatabaseReadiness } from '../../db/pool.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/health', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await checkDatabaseReadiness();
      return { ok: true };
    } catch {
      reply.status(503);
      return { ok: false };
    }
  });

  app.get('/version', async () => ({
    ok: true,
    name: 'spielkind-core',
    version: appConfig.APP_VERSION
  }));
}
