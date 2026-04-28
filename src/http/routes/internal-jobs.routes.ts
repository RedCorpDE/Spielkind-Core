import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appConfig } from '../../config/env.js';
import { INTERNAL_JOB_ROUTE_PREFIX, internalJobDefinitions } from '../../jobs/internal-job-registry.js';
import { UnauthorizedHttpError, ValidationHttpError } from '../errors.js';

function ensureCronAuthorization(request: FastifyRequest, reply: FastifyReply): void {
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${appConfig.CRON_SECRET}`) {
    throw new UnauthorizedHttpError('Invalid cron authorization');
  }
}

export async function registerInternalJobRoutes(app: FastifyInstance): Promise<void> {
  for (const definition of internalJobDefinitions) {
    app.post(`${INTERNAL_JOB_ROUTE_PREFIX}/${definition.routePath}`, async (request, reply) => {
      ensureCronAuthorization(request, reply);

      const parsed = definition.bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new ValidationHttpError(`Invalid ${definition.routePath} request body.`);
      }

      return definition.run(parsed.data);
    });
  }
}
