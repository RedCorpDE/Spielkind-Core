import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPermissionScope, hasPermission, type AccessContext, type PermissionResource } from '../../access-control/model.js';
import {
  listAdminErrorEvents,
  recordAdminErrorEvent
} from '../../errors/admin-error-events.repository.js';
import { getAdminAccessContext, requireAdminPermission } from '../access-control.js';
import { type AdminFastifyRequest, requireAdminAuth } from '../admin.js';
import { ValidationHttpError } from '../errors.js';

const severitySchema = z.enum(['warning', 'error', 'critical']);
const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  source: z.string().trim().max(80).optional(),
  severity: severitySchema.optional(),
  actorUserId: z.string().uuid().optional(),
  actor: z.string().trim().max(160).optional(),
  entityType: z.string().trim().max(80).optional(),
  search: z.string().trim().max(120).optional()
});

const clientReportSchema = z.object({
  clientEventId: z.string().uuid(),
  occurredAt: z.string().datetime().optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/),
  severity: severitySchema,
  operation: z.string().trim().max(160).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(160).optional(),
  bookingId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  regiondoBookingKey: z.string().trim().max(160).optional()
}).strict();

const anonymousReports = new Map<string, { count: number; startedAt: number }>();
const ANONYMOUS_WINDOW_MS = 60_000;
const ANONYMOUS_LIMIT = 30;
const ANONYMOUS_AUTH_CODES = new Set([
  'AUTH_INVALID_CREDENTIALS', 'AUTH_PASSWORD_TOO_SHORT', 'AUTH_RATE_LIMITED', 'AUTH_REGISTRATION_FAILED',
  'AUTH_SESSION_EXPIRED', 'AUTH_SESSION_REQUIRED'
]);
const anonymousOperationByCode: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: 'POST /api/admin/auth/login',
  AUTH_PASSWORD_TOO_SHORT: 'POST /api/admin/auth/register',
  AUTH_RATE_LIMITED: 'POST /api/admin/auth/login',
  AUTH_REGISTRATION_FAILED: 'POST /api/admin/auth/register',
  AUTH_SESSION_EXPIRED: 'POST /api/admin/auth/refresh',
  AUTH_SESSION_REQUIRED: 'POST /api/admin/auth/refresh'
};

function allowAnonymousReport(ip: string): boolean {
  const now = Date.now();
  const entry = anonymousReports.get(ip);
  if (!entry || now - entry.startedAt >= ANONYMOUS_WINDOW_MS) {
    anonymousReports.set(ip, { count: 1, startedAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= ANONYMOUS_LIMIT;
}

function toItem(row: Record<string, unknown>, accessContext: AccessContext) {
  const readDate = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');
  const locationId = typeof row.location_id === 'string' ? row.location_id : null;
  const canViewBooking = hasPermission(accessContext, 'bookings', 'view', { locationId });
  const canViewTask = hasPermission(accessContext, 'tasks', 'view', {
    locationId,
    ownerUserId: typeof row.task_owner_user_id === 'string' ? row.task_owner_user_id : null
  });
  const entityType = typeof row.entity_type === 'string' ? row.entity_type : null;
  const resourceByEntity: Partial<Record<string, PermissionResource>> = {
    booking: 'bookings', location: 'locations', product: 'products', reminder: 'messages', reminder_delivery: 'messages', task: 'tasks'
  };
  const entityResource = entityType ? resourceByEntity[entityType] : undefined;
  const canViewEntity = entityType === 'booking' ? canViewBooking : entityType === 'task' ? canViewTask
    : entityResource ? hasPermission(accessContext, entityResource, 'view', { locationId }) : true;
  return {
    id: row.id,
    occurredAt: readDate(row.occurred_at),
    source: row.source,
    severity: row.severity,
    errorCode: row.error_code,
    messageParams: row.message_params ?? {},
    diagnosticSummary: row.diagnostic_summary,
    actor: { type: row.actor_type, userId: row.actor_user_id, name: row.actor_name, role: row.actor_role },
    operation: row.operation,
    httpStatus: row.http_status,
    entity: { type: canViewEntity ? row.entity_type : null, id: canViewEntity ? row.entity_id : null },
    bookingId: canViewBooking ? row.booking_id : null,
    taskId: canViewTask ? row.task_id : null,
    locationId,
    regiondoBookingKey: canViewBooking ? row.regiondo_booking_key : null,
    reminderDeliveryId: row.reminder_delivery_id,
    jobRunId: row.job_run_id,
    metadata: row.metadata ?? {}
  };
}

export async function registerAdminErrorEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/error-events', async (request) => {
    const { accessContext } = await requireAdminPermission(request as AdminFastifyRequest, 'errors', 'view');
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationHttpError('Invalid error log filters.');
    const includeDiagnostics = getPermissionScope(accessContext.permissions, 'errors', 'manage') !== 'none';
    const result = await listAdminErrorEvents({
      ...parsed.data,
      scope: getPermissionScope(accessContext.permissions, 'errors', 'view'),
      userId: accessContext.userId,
      locationIds: accessContext.userLocationIds,
      includeDiagnostics
    });
    return { ok: true, ...result, items: result.items.map((row) => toItem(row, accessContext)) };
  });

  app.post('/api/admin/error-events/client', async (request, reply) => {
    const parsed = clientReportSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid error report.');

    let auth = null;
    if (request.headers.authorization) auth = await requireAdminAuth(request as AdminFastifyRequest);
    if (!auth) {
      if (!ANONYMOUS_AUTH_CODES.has(parsed.data.errorCode) || !allowAnonymousReport(request.ip)) {
        return reply.code(204).send();
      }
    } else {
      await getAdminAccessContext(request as AdminFastifyRequest);
    }

    try {
      await recordAdminErrorEvent({
        correlationId: parsed.data.clientEventId,
        dedupeKey: `request:${parsed.data.clientEventId}`,
        occurredAt: parsed.data.occurredAt,
        source: parsed.data.errorCode.startsWith('AUTH_') ? 'authentication' : 'dashboard',
        severity: auth ? parsed.data.severity : 'warning',
        errorCode: parsed.data.errorCode,
        actorType: auth ? 'user' : 'anonymous',
        actorUserId: auth?.user.id,
        actorName: auth?.user.displayName ?? 'Anonymous',
        actorRole: auth?.user.role,
        operation: auth ? parsed.data.operation : anonymousOperationByCode[parsed.data.errorCode],
        entityType: auth ? parsed.data.entityType : undefined,
        entityId: auth ? parsed.data.entityId : undefined,
        bookingId: auth ? parsed.data.bookingId : undefined,
        taskId: auth ? parsed.data.taskId : undefined,
        locationId: auth ? parsed.data.locationId : undefined,
        regiondoBookingKey: auth ? parsed.data.regiondoBookingKey : undefined
      });
    } catch {
      // Error reporting is best effort and must never replace the user's original result.
    }
    return reply.code(204).send();
  });
}
