import { pool } from '../../../../db/pool.js';
import type { ProviderCreateBookingInput, ProviderCreateBookingResult } from '../../../bookings/booking-provider.js';
import { normalizeRegiondoBookingImport } from '../../../bookings/booking-normalizer.js';
import { importNormalizedRegiondoBooking } from '../../../bookings/booking.repository.js';
import { regiondoClient, type RegiondoCheckoutCartItem } from '../../../regiondo/regiondo.client.js';

function requestIdentifier(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function localRegiondoDateTime(value: string, timezone: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function bookingKeys(purchaseData: unknown): string[] {
  if (!purchaseData || typeof purchaseData !== 'object' || !('items' in purchaseData)) return [];
  const items = (purchaseData as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return Array.from(new Set(items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = (item as { booking_key?: unknown }).booking_key;
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  })));
}

export async function createRegiondoBooking(input: ProviderCreateBookingInput): Promise<ProviderCreateBookingResult> {
  const prior = await pool.query<{ booking_id: string }>(
    `SELECT booking_id FROM bookings WHERE idempotency_key = $1 LIMIT 1`,
    [input.idempotencyKey]
  );
  if (prior.rowCount) return { bookingId: prior.rows[0].booking_id, created: false };

  const context = await pool.query<{
    timezone: string; external_product_id: string | null; external_variant_id: string | null;
    first_name: string; last_name: string; email: string | null; phone_number: string | null;
  }>(
    `SELECT offering.timezone,
            COALESCE(offering_ref.external_id, product_ref.external_id, product.regiondo_product_id) AS external_product_id,
            variant_ref.external_id AS external_variant_id,
            client.first_name, client.last_name, client.email::text, client.phone_number
     FROM location_products offering
     INNER JOIN products product ON product.product_id = offering.product_id
     INNER JOIN clients client ON client.client_id = $4
     LEFT JOIN provider_references offering_ref
       ON offering_ref.provider = 'regiondo' AND offering_ref.entity_type = 'product_offering'
      AND offering_ref.entity_id = offering.product_offering_id
     LEFT JOIN provider_references product_ref
       ON product_ref.provider = 'regiondo' AND product_ref.entity_type = 'product'
      AND product_ref.entity_id = product.product_id
     LEFT JOIN provider_references variant_ref
       ON variant_ref.provider = 'regiondo' AND variant_ref.entity_type = 'product_variant'
      AND variant_ref.entity_id = $3::uuid
     WHERE offering.product_offering_id = $1 AND offering.product_id = $2
       AND offering.booking_provider = 'regiondo' AND offering.enabled = true
     LIMIT 1`,
    [input.intent.locationProductId, input.intent.productId, input.intent.variantId ?? null, input.clientId]
  );
  const row = context.rows[0];
  if (!row?.external_product_id) throw new Error('The offering is missing its Regiondo product mapping.');
  if (!row.email) throw new Error('An email address is required to create a Regiondo booking.');

  const selectedOptions = input.intent.options ?? [];
  const mappedOptions = selectedOptions.length
    ? await pool.query<{ option_id: string; regiondo_option_id: string | null }>(
        `SELECT option_id, regiondo_option_id FROM product_options WHERE option_id = ANY($1::uuid[])`,
        [selectedOptions.map((option) => option.optionId)]
      )
    : { rows: [], rowCount: 0 };
  if (mappedOptions.rows.length !== selectedOptions.length || mappedOptions.rows.some((option) => !option.regiondo_option_id)) {
    throw new Error('One or more selected options are not linked to Regiondo.');
  }
  if (mappedOptions.rows.length > 1) {
    throw new Error('Regiondo currently supports one mapped option per booking item.');
  }
  const mappedOption = mappedOptions.rows[0];
  const selectedOption = selectedOptions.find((option) => option.optionId === mappedOption?.option_id);
  const item: RegiondoCheckoutCartItem = {
    product_id: requestIdentifier(row.external_product_id),
    qty: input.intent.participants ?? input.intent.quantities?.participants ?? 1,
    date_time: localRegiondoDateTime(input.intent.startAt, row.timezone),
    ...(row.external_variant_id ? { option_id: requestIdentifier(row.external_variant_id) } : {}),
    ...(mappedOption?.regiondo_option_id ? { option_id: requestIdentifier(mappedOption.regiondo_option_id) } : {}),
    ...(selectedOption?.value ? { value: selectedOption.value } : {})
  };
  const purchaseData = await regiondoClient.purchaseOrder({
    contactData: {
      firstname: row.first_name,
      lastname: row.last_name,
      email: row.email,
      ...(row.phone_number ? { telephone: row.phone_number } : {})
    },
    items: [item],
    sendTicketsToCustomer: input.source !== 'dashboard',
    subId: input.idempotencyKey,
    syncTicketsProcessing: true
  });
  const keys = bookingKeys(purchaseData);
  if (!keys.length) throw new Error('Regiondo did not return a booking reference.');

  const bookingIds: string[] = [];
  for (const key of keys) {
    const supplierBookings = await regiondoClient.listSupplierBookings({ bookingKey: key, limit: 250 });
    const normalized = normalizeRegiondoBookingImport({ bookingKey: key, purchaseData, supplierBookings, webhookPayload: null });
    const imported = await importNormalizedRegiondoBooking(normalized);
    bookingIds.push(imported.bookingId);
  }
  await pool.query(
    `UPDATE bookings
     SET product_offering_id = $2, idempotency_key = CASE WHEN booking_id = $1 THEN $3 ELSE idempotency_key END,
         source = CASE WHEN $4 = 'dashboard' THEN 'manual' ELSE source END,
         booking_source = CASE $4 WHEN 'dashboard' THEN 'dashboard' WHEN 'wordpress' THEN 'wordpress' ELSE 'native_app' END,
         updated_at = now()
     WHERE booking_id = ANY($5::uuid[])`,
    [bookingIds[0], input.intent.locationProductId, input.idempotencyKey, input.source, bookingIds]
  );
  return { bookingId: bookingIds[0], bookingIds, created: true };
}

