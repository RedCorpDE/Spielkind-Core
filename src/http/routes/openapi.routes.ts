import type { FastifyInstance } from 'fastify';
import { coreOpenApiDocument } from '../openapi.js';

export async function registerOpenApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return coreOpenApiDocument;
  });
}
