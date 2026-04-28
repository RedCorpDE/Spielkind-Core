import { createHash } from 'node:crypto';
import { enqueueRegiondoWebhookEvents } from './regiondo-webhook.repository.js';
import {
  legacyRegiondoBookingSchema,
  regiondoWebhookPayloadSchema,
  type RegiondoWebhookPayload
} from './regiondo.types.js';

export class RegiondoWebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegiondoWebhookValidationError';
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringifyRegiondoId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function isPurchaseDataPushPayload(payload: RegiondoWebhookPayload): payload is Extract<RegiondoWebhookPayload, { full_purchase_data: unknown }> {
  return 'full_purchase_data' in payload;
}

function extractBookingKeys(payload: RegiondoWebhookPayload): string[] {
  if (isPurchaseDataPushPayload(payload)) {
    return Array.from(new Set(payload.full_purchase_data.items.map((item) => item.booking_key).filter(Boolean)));
  }

  const parsed = legacyRegiondoBookingSchema.parse(payload);
  const bookingKey = stringifyRegiondoId(parsed.id);
  return bookingKey ? [bookingKey] : [];
}

function extractOrderNumber(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return stringifyRegiondoId(payload.full_purchase_data.order_number);
  }

  return null;
}

function extractActionType(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.action_type;
  }

  return 'legacy_booking_event';
}

function extractChannel(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.channel;
  }

  return 'unknown';
}

function extractEventTimestamp(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    return payload.full_purchase_data.info_generated_at;
  }

  const parsed = legacyRegiondoBookingSchema.parse(payload);
  return parsed.start_date ?? parsed.end_date ?? null;
}

function extractStatus(payload: RegiondoWebhookPayload): string | null {
  if (isPurchaseDataPushPayload(payload)) {
    const firstItem = payload.full_purchase_data.items[0];
    return firstItem?.status ?? null;
  }

  const parsed = legacyRegiondoBookingSchema.parse(payload);
  return parsed.status ?? null;
}

export function buildRegiondoWebhookDedupeKey(payload: RegiondoWebhookPayload, bookingKey: string): string {
  const stableParts = [
    bookingKey,
    extractOrderNumber(payload),
    extractActionType(payload),
    extractChannel(payload),
    extractStatus(payload),
    extractEventTimestamp(payload)
  ].filter((value): value is string => Boolean(value));

  if (stableParts.length > 0) {
    return sha256(stableParts.join('|'));
  }

  return sha256(stableStringify(payload));
}

export async function enqueueRegiondoWebhook(input: {
  payload: unknown;
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ insertedCount: number; duplicate: boolean }> {
  const parsed = regiondoWebhookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new RegiondoWebhookValidationError('Webhook payload does not match a supported Regiondo shape.');
  }

  const bookingKeys = extractBookingKeys(parsed.data);
  if (!bookingKeys.length) {
    throw new RegiondoWebhookValidationError('Webhook payload does not include any booking identifiers.');
  }

  const dedupeKeyByBookingKey = new Map(bookingKeys.map((bookingKey) => [bookingKey, buildRegiondoWebhookDedupeKey(parsed.data, bookingKey)]));
  const insertedCount = await enqueueRegiondoWebhookEvents({
    payload: parsed.data,
    bookingKeys,
    dedupeKeyByBookingKey,
    orderNumber: extractOrderNumber(parsed.data),
    actionType: extractActionType(parsed.data),
    channel: extractChannel(parsed.data),
    providerSnapshotAt: extractEventTimestamp(parsed.data),
    headers: input.headers
  });

  return {
    insertedCount,
    duplicate: insertedCount === 0
  };
}
