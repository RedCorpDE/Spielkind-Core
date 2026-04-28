import type { FastifyInstance, FastifyRequest } from 'fastify';
import { appConfig } from '../../config/env.js';
import { UnauthorizedHttpError, ValidationHttpError } from '../errors.js';
import { verifyRegiondoWebhookSignature } from '../../modules/regiondo/regiondo.auth.js';
import { enqueueRegiondoWebhook, RegiondoWebhookValidationError } from '../../modules/regiondo/regiondo-webhook.service.js';

type FastifyRequestWithRawBody = FastifyRequest & { rawBody?: string };

async function handleWebhook(request: FastifyRequestWithRawBody) {
  if (appConfig.WEBHOOK_AUTH_HEADER_NAME && appConfig.WEBHOOK_AUTH_HEADER_VALUE) {
    const headerValue = request.headers[appConfig.WEBHOOK_AUTH_HEADER_NAME.toLowerCase()];
    if (headerValue !== appConfig.WEBHOOK_AUTH_HEADER_VALUE) {
      throw new UnauthorizedHttpError('Invalid webhook authentication header.');
    }
  }

  if (appConfig.REGIONDO_WEBHOOK_SECRET) {
    const signatureHeader = request.headers['x-regiondo-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const valid = verifyRegiondoWebhookSignature(
      request.rawBody ?? JSON.stringify(request.body ?? {}),
      signature,
      appConfig.REGIONDO_WEBHOOK_SECRET
    );

    if (!valid) {
      throw new UnauthorizedHttpError('Invalid Regiondo webhook signature.');
    }
  }

  try {
    const result = await enqueueRegiondoWebhook({
      payload: request.body,
      headers: request.headers as Record<string, string | string[] | undefined>
    });

    return {
      ok: true,
      accepted: true,
      duplicate: result.duplicate,
      inserted_events: result.insertedCount
    };
  } catch (error) {
    if (error instanceof RegiondoWebhookValidationError) {
      throw new ValidationHttpError(error.message);
    }

    throw error;
  }
}

export async function registerRegiondoWebhookRoutes(app: FastifyInstance): Promise<void> {
  const configuredPath = appConfig.WEBHOOK_BOOKINGS_PATH;
  const canonicalPath = '/webhooks/regiondo';
  const paths = new Set([canonicalPath, configuredPath]);

  for (const path of paths) {
    app.get(path, async () => ({ ok: true }));
    app.post(path, async (request) => handleWebhook(request as FastifyRequestWithRawBody));
  }
}
