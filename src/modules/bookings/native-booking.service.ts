import { withTransaction } from '../../db/transaction.js';
import { attachReservationHold } from '../availability/reservation-hold.service.js';
import { quoteWithClient, type PricingQuoteInput } from '../pricing/pricing.service.js';
import { resolveCancellationPolicySnapshot } from '../cancellations/cancellation-policy.service.js';

export interface CreateNativeBookingInput extends PricingQuoteInput {
  clientId: string;
  locationId: string;
  locationProductId?: string;
  startsAt: string;
  endsAt: string;
  holdId: string;
  idempotencyKey: string;
  allowProviderCatalog?: boolean;
}

export async function createNativeBooking(input: CreateNativeBookingInput): Promise<{ bookingId: string; created: boolean }> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ booking_id: string }>(
      `SELECT booking_id FROM bookings WHERE idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (existing.rowCount) return { bookingId: existing.rows[0].booking_id, created: false };

    const product = await client.query<{ booking_provider: string; product_offering_id: string | null }>(
      `SELECT COALESCE(offering.booking_provider, product.booking_provider) AS booking_provider,
              offering.product_offering_id
       FROM products product
       LEFT JOIN location_products offering
         ON offering.product_offering_id = $2::uuid
        AND offering.product_id = product.product_id
        AND offering.location_id = $3::uuid
        AND offering.enabled = true
       WHERE product.product_id = $1`,
      [input.productId, input.locationProductId ?? null, input.locationId]
    );
    if (!product.rowCount) throw new Error('Product was not found.');
    if (input.locationProductId && product.rows[0].product_offering_id !== input.locationProductId) {
      throw new Error('Product, location, and offering do not match.');
    }
    if (product.rows[0].booking_provider !== 'core' && !input.allowProviderCatalog) {
      throw new Error('This product is managed by an external booking provider.');
    }

    const hold = await client.query<{
      client_id: string | null; location_id: string; product_id: string; product_offering_id: string | null;
      product_variant_id: string | null;
      quantity: number; starts_at: string; ends_at: string;
    }>(
      `SELECT client_id, location_id, product_id, product_offering_id, product_variant_id, quantity, starts_at, ends_at
       FROM reservation_holds WHERE reservation_hold_id = $1 FOR UPDATE`,
      [input.holdId]
    );
    const held = hold.rows[0];
    if (!held || (held.client_id && held.client_id !== input.clientId) || held.location_id !== input.locationId ||
        held.product_id !== input.productId ||
        (input.locationProductId && held.product_offering_id !== input.locationProductId) ||
        held.product_variant_id !== (input.variantId ?? null) ||
        held.quantity !== input.quantity || new Date(held.starts_at).getTime() !== new Date(input.startsAt).getTime() ||
        new Date(held.ends_at).getTime() !== new Date(input.endsAt).getTime()) {
      throw new Error('Reservation hold does not match the booking request.');
    }

    const quote = await quoteWithClient(client, input);
    const policySnapshot = await resolveCancellationPolicySnapshot(client, input.productId, input.variantId);
    const inserted = await client.query<{ booking_id: string }>(
      `INSERT INTO bookings (
         client_id, location_id, product_offering_id, status, guest_count, total_amount, paid_amount,
         dt_from, dt_to, source, booking_provider, currency, idempotency_key,
         cancellation_policy_snapshot
       ) VALUES ($1, $2, $3, 'payment_pending', $4, $5, 0, $6::timestamptz, $7::timestamptz, 'app', 'core', $8, $9, $10::jsonb)
       RETURNING booking_id`,
      [
        input.clientId, input.locationId, input.locationProductId ?? null, input.quantity, quote.total / 100, input.startsAt,
        input.endsAt, quote.currency, input.idempotencyKey,
        policySnapshot ? JSON.stringify(policySnapshot) : null
      ]
    );
    const bookingId = inserted.rows[0].booking_id;

    for (const item of quote.items) {
      const bookingItem = await client.query<{ booking_item_id: string }>(
        `INSERT INTO booking_items (
           booking_id, product_id, product_offering_id, product_variant_id, quantity,
           product_name_snapshot, variant_name_snapshot,
           unit_price_net, unit_price_gross, vat_basis_points,
           subtotal_net, tax_amount, subtotal_gross, currency, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         RETURNING booking_item_id`,
        [
          bookingId, item.productId, input.locationProductId ?? null, item.variantId, item.quantity, item.productName, item.variantName,
          item.unitPriceNet, item.unitPriceGross, item.vatBasisPoints,
          item.subtotalNet, item.tax, item.subtotalGross, item.currency,
          JSON.stringify({
            discountMinor: quote.discount,
            pricingMode: item.pricingMode,
            billableDateUnits: item.dateUnits,
            quantity: item.quantity,
            effectiveUnitRateMinor: item.effectiveUnitRate,
            subtotalBeforeOptionsMinor: item.subtotalBeforeOptions,
            optionsSubtotalMinor: item.optionsSubtotal
          })
        ]
      );
      await client.query(
        `INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (booking_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price`,
        [bookingId, item.productId, item.quantity, item.unitPriceGross / 100]
      );
      for (const option of item.options) {
        await client.query(
          `INSERT INTO booking_item_options (
             booking_item_id, product_option_id, option_name_snapshot, value_snapshot,
             price_delta_snapshot, currency
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [bookingItem.rows[0].booking_item_id, option.optionId, option.name, option.value, option.priceDelta, item.currency]
        );
      }
    }

    await attachReservationHold(client, input.holdId, bookingId);
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('booking', $1, 'booking.created', $2::jsonb)`,
      [bookingId, JSON.stringify({ bookingId, provider: 'core', status: 'payment_pending' })]
    );
    return { bookingId, created: true };
  }, { isolationLevel: 'SERIALIZABLE' });
}

