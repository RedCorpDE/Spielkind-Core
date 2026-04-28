import type { FastifyRequest } from 'fastify';
import type { AuthenticatedAdmin } from '../auth/types.js';
import { recordAdminAuditEvent } from '../auth/repository.js';
import { getRequestMetadata } from './admin.js';

export async function recordAdminWriteAudit(input: {
  request: FastifyRequest;
  auth: AuthenticatedAdmin;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const metadata = getRequestMetadata(input.request);

  await recordAdminAuditEvent({
    actorUserId: input.auth.user.id,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    details: input.details,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent
  });
}
