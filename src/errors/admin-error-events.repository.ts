import { Buffer } from 'node:buffer';
import { pool } from '../db/client.js';
import type { PermissionScope } from '../access-control/model.js';

export type AdminErrorSeverity = 'warning' | 'error' | 'critical';
export type AdminErrorActorType = 'user' | 'anonymous' | 'system' | 'provider';

export interface RecordAdminErrorEventInput {
  correlationId?: string | null;
  dedupeKey?: string | null;
  occurredAt?: string;
  source: string;
  severity: AdminErrorSeverity;
  errorCode: string;
  messageParams?: Record<string, string | number | boolean | null>;
  diagnosticSummary?: string | null;
  actorType: AdminErrorActorType;
  actorUserId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  operation?: string | null;
  httpStatus?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  bookingId?: string | null;
  taskId?: string | null;
  locationId?: string | null;
  regiondoBookingKey?: string | null;
  reminderDeliveryId?: string | null;
  jobRunId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

const sanitizeText = (value: string | null | undefined, max = 500): string | null => {
  const normalized = value?.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
};

const sanitizeDiagnostic = (value: string | null | undefined): string | null => {
  const normalized = sanitizeText(value);
  if (!normalized) return null;
  if (/^[\[{]/.test(normalized) || /\b(raw_json|payload|schema|password|authorization|access[_ -]?token|refresh[_ -]?token)\b/i.test(normalized)) {
    return 'Diagnostic details omitted.';
  }
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]');
};

const ALLOWED_DATA_KEYS = new Set(['affectedBookingCount', 'attempt', 'channel', 'jobType', 'retryable', 'savedLocally']);
const sanitizeData = (value: Record<string, string | number | boolean | null> | undefined) =>
  Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, entry]) => {
    if (!ALLOWED_DATA_KEYS.has(key)) return [];
    return [[key, typeof entry === 'string' ? sanitizeText(entry, 200) : entry]];
  }));

export async function recordAdminErrorEvent(input: RecordAdminErrorEventInput): Promise<void> {
  await pool.query(
    `INSERT INTO admin_error_events (
       correlation_id, dedupe_key, occurred_at, source, severity, error_code, message_params,
       diagnostic_summary, actor_type, actor_user_id, actor_name, actor_role,
       operation, http_status, entity_type, entity_id, booking_id, task_id,
       location_id, regiondo_booking_key, reminder_delivery_id, job_run_id, metadata
     ) VALUES (
       $1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7::jsonb,
       $8, $9, $10, $11, $12, $13, $14, $15, $16,
       COALESCE($17::uuid, (SELECT booking_id FROM bookings WHERE regiondo_booking_id = $20 LIMIT 1)),
       $18,
       COALESCE($19::uuid, (SELECT location_id FROM bookings WHERE booking_id = $17::uuid),
         (SELECT b.location_id FROM tasks t LEFT JOIN bookings b ON b.booking_id = t.connected_booking_key WHERE t.id = $18::uuid)),
       $20, $21, $22, $23::jsonb
     )
     ON CONFLICT (dedupe_key) DO UPDATE
       SET message_params = admin_error_events.message_params || EXCLUDED.message_params,
           metadata = admin_error_events.metadata || EXCLUDED.metadata`,
    [
      sanitizeText(input.correlationId, 200), sanitizeText(input.dedupeKey, 200), input.occurredAt ?? null, sanitizeText(input.source, 80), input.severity,
      sanitizeText(input.errorCode, 120), JSON.stringify(sanitizeData(input.messageParams)),
      sanitizeDiagnostic(input.diagnosticSummary), input.actorType, input.actorUserId ?? null,
      sanitizeText(input.actorName, 160), sanitizeText(input.actorRole, 100), sanitizeText(input.operation, 160),
      input.httpStatus ?? null, sanitizeText(input.entityType, 80), sanitizeText(input.entityId, 160),
      input.bookingId ?? null, input.taskId ?? null, input.locationId ?? null,
      sanitizeText(input.regiondoBookingKey, 160), input.reminderDeliveryId ?? null, input.jobRunId ?? null,
      JSON.stringify(sanitizeData(input.metadata))
    ]
  );
}

interface ErrorCursor { occurredAt: string; id: string }
const encodeCursor = (cursor: ErrorCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const decodeCursor = (value?: string): ErrorCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ErrorCursor;
    return parsed.occurredAt && parsed.id ? parsed : null;
  } catch { return null; }
};

export interface ListAdminErrorEventsInput {
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
  source?: string;
  severity?: AdminErrorSeverity;
  actorUserId?: string;
  actor?: string;
  entityType?: string;
  search?: string;
  scope: PermissionScope;
  userId: string;
  locationIds: string[];
  includeDiagnostics: boolean;
}

export async function listAdminErrorEvents(input: ListAdminErrorEventsInput) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const cursor = decodeCursor(input.cursor);
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };

  if (input.scope === 'own') where.push(`e.actor_user_id = ${add(input.userId)}::uuid`);
  if (input.scope === 'location') {
    where.push(`e.location_id = ANY(${add(input.locationIds)}::uuid[])`);
  }
  if (input.from) where.push(`e.occurred_at >= ${add(input.from)}::timestamptz`);
  if (input.to) where.push(`e.occurred_at <= ${add(input.to)}::timestamptz`);
  if (input.source) where.push(`e.source = ${add(input.source)}`);
  if (input.severity) where.push(`e.severity = ${add(input.severity)}`);
  if (input.actorUserId) where.push(`e.actor_user_id = ${add(input.actorUserId)}::uuid`);
  if (input.actor) where.push(`e.actor_name = ${add(input.actor)}`);
  if (input.entityType) where.push(`e.entity_type = ${add(input.entityType)}`);
  if (input.search) {
    const p = add(`%${input.search.trim()}%`);
    where.push(`(e.error_code ILIKE ${p} OR e.entity_id ILIKE ${p} OR e.regiondo_booking_key ILIKE ${p} OR e.actor_name ILIKE ${p})`);
  }
  if (cursor) {
    const date = add(cursor.occurredAt);
    const id = add(cursor.id);
    where.push(`(e.occurred_at, e.error_event_id) < (${date}::timestamptz, ${id}::uuid)`);
  }

  values.push(limit + 1);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT e.error_event_id AS id, e.occurred_at, e.source, e.severity, e.error_code,
            e.message_params, ${input.includeDiagnostics ? 'e.diagnostic_summary' : 'NULL'} AS diagnostic_summary,
            e.actor_type, e.actor_user_id, e.actor_name, e.actor_role, e.operation, e.http_status,
            e.entity_type, e.entity_id, e.booking_id, e.task_id, e.location_id,
            (SELECT assignee_user_id FROM tasks WHERE id = e.task_id) AS task_owner_user_id,
            e.regiondo_booking_key, e.reminder_delivery_id, e.job_run_id, e.metadata
     FROM admin_error_events e
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.occurred_at DESC, e.error_event_id DESC
     LIMIT $${values.length}`,
    values
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1) as { id?: string; occurred_at?: Date | string } | undefined;
  const nextCursor = result.rows.length > limit && last?.id && last.occurred_at
    ? encodeCursor({ id: last.id, occurredAt: new Date(last.occurred_at).toISOString() }) : null;

  const facetValues: unknown[] = [];
  const facetWhere: string[] = [];
  const addFacet = (value: unknown) => { facetValues.push(value); return `$${facetValues.length}`; };
  if (input.scope === 'own') facetWhere.push(`actor_user_id = ${addFacet(input.userId)}::uuid`);
  if (input.scope === 'location') facetWhere.push(`location_id = ANY(${addFacet(input.locationIds)}::uuid[])`);
  const facetScope = facetWhere.length ? `WHERE ${facetWhere.join(' AND ')}` : '';
  const facetScopeAnd = facetWhere.length ? `AND ${facetWhere.join(' AND ')}` : '';
  const facets = await pool.query<{ kind: string; value: string }>(
    `SELECT 'source' AS kind, source AS value FROM admin_error_events ${facetScope} GROUP BY source
     UNION ALL SELECT 'severity', severity FROM admin_error_events ${facetScope} GROUP BY severity
     UNION ALL SELECT 'actor', actor_name FROM admin_error_events WHERE actor_name IS NOT NULL ${facetScopeAnd} GROUP BY actor_name
     UNION ALL SELECT 'entity', entity_type FROM admin_error_events WHERE entity_type IS NOT NULL ${facetScopeAnd} GROUP BY entity_type`,
    facetValues
  );
  return { items: rows, nextCursor, facets: facets.rows };
}

export async function pruneAdminErrorEvents(retentionDays = 90): Promise<number> {
  const result = await pool.query(
    `DELETE FROM admin_error_events WHERE occurred_at < now() - ($1::text || ' days')::interval`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}
