import { regiondoClient } from '../regiondo/client.js';
import {
  claimRegiondoWebhookEvents,
  enqueueRegiondoWebhookEvents,
  getCanonicalBookingIdentifiers,
  getRegiondoWebhookEvent,
  importCanonicalRegiondoBooking,
  markRegiondoWebhookEventDeadLetter,
  markRegiondoWebhookEventProcessed,
  markRegiondoWebhookEventRetry,
  retryRegiondoWebhookEvent,
  upsertProductWithDetails
} from './repository.js';
import { failSync, finishSync, startSync } from './sync-log.js';
import {
  extractBookingKeysFromWebhook,
  extractWebhookActionType,
  extractWebhookChannel,
  extractWebhookOrderNumber,
  extractWebhookSnapshotAt,
  isPurchaseDataPushPayload,
  stringifyRegiondoId
} from './mappers.js';
import {
  legacyRegiondoBookingSchema,
  regiondoPurchaseDataSchema,
  regiondoSupplierBookingsSchema,
  regiondoWebhookPayloadSchema,
  type RegiondoProduct
} from './types.js';

const MAX_WEBHOOK_ATTEMPTS = 8;

export class RegiondoWebhookValidationError extends Error {}
export class RegiondoWebhookTransientError extends Error {}

export async function syncProductsAndVariants(): Promise<number> {
  const syncId = await startSync('products');
  try {
    const products = await regiondoClient.getCollection<RegiondoProduct>('/products');

    for (const product of products) {

      console.log(`Product ${product.id} + ${product.product_name}`);

      await upsertProductWithDetails(product);
    }

    await finishSync(syncId, products.length);
    return products.length;
  } catch (error) {
    await failSync(syncId, error);
    throw error;
  }
}

function ensureDateString(value: string | null | undefined, fieldName: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new RegiondoWebhookValidationError(`${fieldName} must be a valid ISO date.`);
  }

  return normalized.toISOString();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRetryAt(attemptCount: number): Date {
  const delayMs = Math.min(5 * 60 * 1000, 5_000 * Math.max(1, attemptCount));
  return new Date(Date.now() + delayMs);
}

async function fetchRegiondoSnapshot(bookingKey: string, orderNumberHint: string | null) {
  const supplierBookingsRaw = await regiondoClient.getSupplierBookings({ bookingKey });
  const supplierBookings = regiondoSupplierBookingsSchema.parse(supplierBookingsRaw);

  if (!supplierBookings.length) {
    throw new RegiondoWebhookTransientError(`Regiondo did not return any supplier bookings for ${bookingKey}.`);
  }

  const orderNumber = orderNumberHint ?? stringifyRegiondoId(supplierBookings[0].order_number);
  if (!orderNumber) {
    throw new RegiondoWebhookValidationError(`Regiondo booking ${bookingKey} does not expose an order number.`);
  }

  const purchaseDataRaw = await regiondoClient.getPurchaseByOrderNumber(orderNumber);
  const purchaseData = regiondoPurchaseDataSchema.parse(purchaseDataRaw);

  return { supplierBookings, purchaseData };
}

export async function enqueueBookingWebhook(input: {
  payload: unknown;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<number> {
  const parsed = regiondoWebhookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new RegiondoWebhookValidationError('Webhook payload does not match a supported Regiondo booking format.');
  }

  const bookingKeys = extractBookingKeysFromWebhook(parsed.data);
  if (!bookingKeys.length) {
    throw new RegiondoWebhookValidationError('Webhook payload did not include any booking keys.');
  }

  if (isPurchaseDataPushPayload(parsed.data)) {
    ensureDateString(parsed.data.full_purchase_data.info_generated_at, 'full_purchase_data.info_generated_at');
  } else {
    legacyRegiondoBookingSchema.parse(parsed.data);
  }

  return enqueueRegiondoWebhookEvents({
    payload: parsed.data,
    bookingKeys,
    orderNumber: extractWebhookOrderNumber(parsed.data),
    actionType: extractWebhookActionType(parsed.data),
    channel: extractWebhookChannel(parsed.data),
    providerSnapshotAt: extractWebhookSnapshotAt(parsed.data),
    rawBody: input.rawBody,
    headers: input.headers
  });
}

export async function processPendingBookingWebhookEvents(limit: number): Promise<number> {
  const events = await claimRegiondoWebhookEvents(limit);
  if (!events.length) {
    return 0;
  }

  const syncId = await startSync('bookings');
  let processedCount = 0;

  try {
    for (const event of events) {
      try {
        const payload = regiondoWebhookPayloadSchema.parse(event.payload);
        const snapshot = await fetchRegiondoSnapshot(event.booking_key, event.order_number);
        await importCanonicalRegiondoBooking({
          bookingKey: event.booking_key,
          purchaseData: snapshot.purchaseData,
          supplierBookings: snapshot.supplierBookings,
          webhookPayload: payload
        });
        await markRegiondoWebhookEventProcessed(event.event_id);
        processedCount += 1;
      } catch (error) {
        const message = toErrorMessage(error);

        if (error instanceof RegiondoWebhookValidationError) {
          await markRegiondoWebhookEventDeadLetter(event.event_id, message);
          continue;
        }

        if (event.attempt_count >= MAX_WEBHOOK_ATTEMPTS) {
          await markRegiondoWebhookEventDeadLetter(event.event_id, message);
          continue;
        }

        await markRegiondoWebhookEventRetry(event.event_id, message, getRetryAt(event.attempt_count));
      }
    }

    await finishSync(syncId, processedCount);
    return processedCount;
  } catch (error) {
    await failSync(syncId, error);
    throw error;
  }
}

export async function retryBookingWebhookEvent(eventId: string): Promise<void> {
  const event = await getRegiondoWebhookEvent(eventId);
  if (!event) {
    throw new RegiondoWebhookValidationError('Webhook event not found.');
  }

  if (event.status !== 'retrying' && event.status !== 'dead_letter') {
    throw new RegiondoWebhookValidationError('Only retrying or dead-letter Regiondo webhook events can be retried.');
  }

  const updated = await retryRegiondoWebhookEvent(eventId);
  if (!updated) {
    throw new RegiondoWebhookValidationError('Webhook event could not be requeued.');
  }
}

export async function reconcileCanonicalBooking(bookingId: string): Promise<void> {
  const identifiers = await getCanonicalBookingIdentifiers(bookingId);
  if (!identifiers) {
    throw new RegiondoWebhookValidationError('Booking not found.');
  }

  if (!identifiers.bookingKey) {
    throw new RegiondoWebhookValidationError('Booking does not have a Regiondo booking key and cannot be reconciled.');
  }

  const snapshot = await fetchRegiondoSnapshot(identifiers.bookingKey, identifiers.orderNumber);
  await importCanonicalRegiondoBooking({
    bookingKey: identifiers.bookingKey,
    purchaseData: snapshot.purchaseData,
    supplierBookings: snapshot.supplierBookings,
    webhookPayload: null
  });
}
