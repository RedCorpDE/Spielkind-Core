import { sendAlert } from '../alerts/slack-notifier.js';
import { regiondoClient } from '../regiondo/client.js';
import { upsertBookingFromWebhook, upsertProductWithDetails } from './repository.js';
import { failSync, finishSync, startSync } from './sync-log.js';
import type { RegiondoBooking, RegiondoProduct } from './types.js';

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
    const message = error instanceof Error ? error.message : String(error);
    await sendAlert('error', `Product sync failed: ${message}`, { syncId });
    throw error;
  }
}

export async function processBookingWebhook(payload: RegiondoBooking): Promise<void> {
  const syncId = await startSync('bookings');
  try {
    await upsertBookingFromWebhook(payload);
    await finishSync(syncId, 1);
  } catch (error) {
    await failSync(syncId, error);
    const message = error instanceof Error ? error.message : String(error);
    await sendAlert('error', `Booking webhook processing failed: ${message}`, { syncId, bookingId: payload.id });
    throw error;
  }
}
