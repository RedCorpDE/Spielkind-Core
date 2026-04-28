import type { FastifyReply, FastifyRequest } from 'fastify';
import { DashboardNotFoundError, DashboardValidationError } from '../dashboard/repository/core.js';
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

export class ConflictHttpError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = 'ConflictHttpError';
  }
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

    request.log.error({ err: error }, 'Unhandled request error');
    reply.status(500).send({ ok: false, error: 'Internal Server Error' });
  };
}
