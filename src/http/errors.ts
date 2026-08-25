import type { FastifyReply, FastifyRequest } from 'fastify';
import { DashboardConflictError, DashboardNotFoundError, DashboardValidationError } from '../dashboard/repository/core.js';
import {
  RegiondoApiError,
  RegiondoAuthError,
  RegiondoLocationValidationError,
  RegiondoPurchaseRecoveryRequiredError,
  RegiondoRateLimitError,
  RegiondoTransientError
} from '../modules/regiondo/regiondo.client.js';
import { RegiondoSyncValidationError } from '../sync/repository.js';
import { RegiondoWebhookValidationError } from '../sync/sync-service.js';
import { MissingProductResourceMappingError, OverbookingError } from '../modules/resources/consumption.service.js';
import { recordAdminErrorEvent, type AdminErrorSeverity } from '../errors/admin-error-events.repository.js';
import type { AdminFastifyRequest } from './admin.js';

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

function getStatusCode(error: Error): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof DashboardNotFoundError) return 404;
  if (error instanceof DashboardConflictError || error instanceof OverbookingError || error instanceof MissingProductResourceMappingError) return 409;
  if (error instanceof DashboardValidationError || error instanceof RegiondoSyncValidationError || error instanceof RegiondoWebhookValidationError) return 400;
  if (error instanceof RegiondoPurchaseRecoveryRequiredError) return 502;
  if (error instanceof RegiondoApiError) return getRegiondoStatusCode(error);
  return 500;
}

function classifyError(error: Error, status: number): { code: string; severity: AdminErrorSeverity; source: string } {
  const message = error.message.toLowerCase();
  if (error instanceof RegiondoLocationValidationError) {
    return { code: 'REGIONDO_LOCATION_INVALID', severity: 'warning', source: 'regiondo' };
  }
  if (message.includes('regiondo-mapped location') || message.includes('regiondo location id')) {
    return { code: 'REGIONDO_LOCATION_MAPPING_REQUIRED', severity: 'warning', source: 'regiondo' };
  }
  if (message.includes('partially applied') || message.includes('reconcile')) {
    return { code: 'PARTIAL_SYNC_REQUIRES_REVIEW', severity: 'critical', source: 'synchronization' };
  }
  if (status === 409 || message.includes('reload before saving') || message.includes('changed after')) {
    return { code: 'STALE_DATA_CONFLICT', severity: 'warning', source: 'admin_api' };
  }
  if (status === 401) return { code: 'AUTH_SESSION_REQUIRED', severity: 'warning', source: 'authentication' };
  if (status === 403) return { code: 'PERMISSION_DENIED', severity: 'warning', source: 'authentication' };
  if (status === 404) return { code: 'RECORD_NOT_AVAILABLE', severity: 'warning', source: 'admin_api' };
  if (error instanceof RegiondoRateLimitError) return { code: 'REGIONDO_RATE_LIMITED', severity: 'error', source: 'regiondo' };
  if (error instanceof RegiondoApiError) return { code: 'REGIONDO_UNAVAILABLE', severity: 'error', source: 'regiondo' };
  if (status === 400) return { code: 'VALIDATION_FAILED', severity: 'warning', source: 'admin_api' };
  return { code: 'UNEXPECTED_ERROR', severity: status >= 500 ? 'critical' : 'error', source: 'admin_api' };
}

async function captureAdminRequestError(error: Error, request: FastifyRequest): Promise<void> {
  const route = request.routeOptions?.url ?? request.url;
  if (!route.startsWith('/api/admin') || route.includes('/error-events')) return;
  const status = getStatusCode(error);
  const classification = classifyError(error, status);
  const params = (request.params ?? {}) as Record<string, unknown>;
  const readParam = (...keys: string[]) => {
    for (const key of keys) if (typeof params[key] === 'string') return params[key] as string;
    return null;
  };
  const auth = (request as AdminFastifyRequest).adminAuth;
  await recordAdminErrorEvent({
    correlationId: request.id,
    dedupeKey: `request:${request.id}`,
    source: classification.source,
    severity: classification.severity,
    errorCode: classification.code,
    diagnosticSummary: status >= 500 && !(error instanceof RegiondoApiError) ? error.name : error.message,
    actorType: auth ? 'user' : 'anonymous',
    actorUserId: auth?.user.id,
    actorName: auth?.user.displayName ?? 'Anonymous',
    actorRole: auth?.user.role,
    operation: `${request.method} ${route}`,
    httpStatus: status,
    entityType: readParam('bookingId') ? 'booking' : readParam('taskId') ? 'task' : null,
    entityId: readParam('bookingId', 'taskId', 'locationId', 'productId', 'eventId', 'deliveryId'),
    bookingId: readParam('bookingId'),
    taskId: readParam('taskId'),
    locationId: readParam('locationId'),
    reminderDeliveryId: readParam('deliveryId')
  });
}

export function registerErrorHandler() {
  return async function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply) {
    try {
      await captureAdminRequestError(error, request);
    } catch {
      // Error reporting is best-effort and must never replace the original response.
    }

    if (error instanceof HttpError) {
      request.log.warn({ err: error }, 'Handled HTTP error');
      reply.status(error.statusCode).send({ ok: false, error: error.message });
      return;
    }

    if (error instanceof DashboardNotFoundError) {
      reply.status(404).send({ ok: false, error: error.message });
      return;
    }

    if (error instanceof DashboardConflictError) {
      reply.status(409).send({ ok: false, error: error.message });
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

    if (error instanceof RegiondoPurchaseRecoveryRequiredError) {
      reply.status(502).send({
        ok: false,
        code: 'REGIONDO_PURCHASE_RECONCILIATION_REQUIRED',
        retryable: false,
        error: error.message,
        reason: error.reason,
        ...(error.subId ? { subId: error.subId } : {}),
        ...(error.orderNumber ? { orderNumber: error.orderNumber } : {}),
        ...(error.orderId ? { orderId: error.orderId } : {})
      });
      return;
    }

    if (error instanceof RegiondoLocationValidationError) {
      reply.status(400).send({
        ok: false,
        code: 'REGIONDO_LOCATION_INVALID',
        error: error.message
      });
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
