import type { FastifyReply, FastifyRequest } from 'fastify';
import { DashboardNotFoundError, DashboardValidationError } from '../dashboard/repository/core.js';
import {
  RegiondoApiError,
  RegiondoAuthError,
  RegiondoRateLimitError,
  RegiondoTransientError
} from '../modules/regiondo/regiondo.client.js';
import { RegiondoSyncValidationError } from '../sync/repository.js';
import { RegiondoWebhookValidationError } from '../sync/sync-service.js';
import { MissingProductResourceMappingError, OverbookingError } from '../modules/resources/consumption.service.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class ValidationHttpError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'ValidationHttpError';
  }
}

export class UnauthorizedHttpError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedHttpError';
  }
}

export class ForbiddenHttpError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
    this.name = 'ForbiddenHttpError';
  }
}

export class ConflictHttpError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = 'ConflictHttpError';
  }
}

function getRegiondoStatusCode(error: RegiondoApiError): number {
  if (error instanceof RegiondoRateLimitError) {
    return 429;
  }

  if (error instanceof RegiondoTransientError) {
    return 503;
  }

  if (error instanceof RegiondoAuthError) {
    return 502;
  }

  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    return 400;
  }

  return 502;
}

export function registerErrorHandler() {
  return async function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply) {
    if (error instanceof HttpError) {
      request.log.warn({ err: error }, 'Handled HTTP error');
      reply.status(error.statusCode).send({ ok: false, error: error.message });
      return;
    }

    if (error instanceof DashboardNotFoundError) {
      reply.status(404).send({ ok: false, error: error.message });
      return;
    }

    if (
      error instanceof DashboardValidationError ||
      error instanceof RegiondoSyncValidationError ||
      error instanceof RegiondoWebhookValidationError
    ) {
      reply.status(400).send({ ok: false, error: error.message });
      return;
    }

    if (error instanceof OverbookingError || error instanceof MissingProductResourceMappingError) {
      reply.status(409).send({ ok: false, error: error.message });
      return;
    }

    if (error instanceof RegiondoApiError) {
      const details = error.responseBody?.trim();

      reply.status(getRegiondoStatusCode(error)).send({
        ok: false,
        error: error.message,
        ...(details ? { details } : {})
      });
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    reply.status(500).send({ ok: false, error: 'Internal Server Error' });
  };
}
