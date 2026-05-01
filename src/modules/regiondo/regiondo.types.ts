import { z } from 'zod';

const regiondoIdentifierSchema = z.union([z.string(), z.number()]);
const invalidRegiondoCatalogIdentifierValues = new Set(['null', 'undefined']);
const requiredRegiondoIdentifierSchema = z.preprocess((value) => {
  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return value;
}, z.string().min(1).refine((value) => !invalidRegiondoCatalogIdentifierValues.has(value.toLowerCase()), {
  message: 'Expected a usable Regiondo identifier.'
}));
const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}, z.string().min(1).optional());
const optionalRegiondoNumberSchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  return value;
}, z.coerce.number().finite().optional());

export const regiondoCatalogVariationOptionSchema = z
  .object({
    option_id: requiredRegiondoIdentifierSchema,
    title: optionalTrimmedStringSchema,
    values: z.unknown().optional()
  })
  .passthrough();

export const regiondoCatalogVariationSchema = z
  .object({
    variation_id: requiredRegiondoIdentifierSchema,
    title: optionalTrimmedStringSchema,
    price: optionalRegiondoNumberSchema,
    base_price: optionalRegiondoNumberSchema,
    original_price: optionalRegiondoNumberSchema,
    values: z.unknown().optional(),
    options: z.array(regiondoCatalogVariationOptionSchema).optional()
  })
  .passthrough();

export const regiondoCatalogProductSchema = z
  .object({
    product_id: requiredRegiondoIdentifierSchema,
    name: optionalTrimmedStringSchema,
    default_name: optionalTrimmedStringSchema,
    short_description: optionalTrimmedStringSchema,
    image: optionalTrimmedStringSchema,
    thumbnail: optionalTrimmedStringSchema,
    base_price: optionalRegiondoNumberSchema,
    original_price: optionalRegiondoNumberSchema,
    variations: z.array(regiondoCatalogVariationSchema).optional()
  })
  .passthrough();

export const regiondoCatalogProductsSchema = z.array(regiondoCatalogProductSchema);

const regiondoContactDataSchema = z
  .object({
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    email: z.string().optional(),
    telephone: z.string().optional()
  })
  .passthrough();

export const regiondoSoldItemSchema = z
  .object({
    unique_item_id: z.string().optional(),
    booking_key: z.string().min(1),
    ticket_name: z.string().optional(),
    product_name: z.string().optional(),
    ticket_variation: z.string().optional(),
    ticket_option: z.string().optional(),
    ticket_qty: z.coerce.number().int().nonnegative().optional(),
    ticket_qty_canceled: z.coerce.number().int().nonnegative().optional(),
    status: z.string().optional(),
    event_date_time: z.string().optional(),
    row_total_incl_tax: z.coerce.number().optional(),
    price_per_one_incl_tax: z.coerce.number().optional(),
    payment_status: z.string().optional(),
    item_type_code: z.string().optional(),
    product_id: regiondoIdentifierSchema.optional(),
    sales_channel: z.string().optional(),
    external_id: z.string().optional(),
    resources: z.array(z.unknown()).optional()
  })
  .passthrough();

export const regiondoPurchaseDataSchema = z
  .object({
    info_generated_at: z.string().min(1),
    order_number: regiondoIdentifierSchema,
    order_id: regiondoIdentifierSchema.optional(),
    purchased_at: z.string().optional(),
    sales_channel: z.string().optional(),
    payment_method: z.string().optional(),
    contact_data: regiondoContactDataSchema.optional(),
    items: z.array(regiondoSoldItemSchema).min(1),
    grand_total: z.coerce.number().optional()
  })
  .passthrough();

export const regiondoPurchaseDataPushSchema = z
  .object({
    action_type: z.string().min(1),
    channel: z.string().min(1),
    updated_items_details: z
      .object({
        contains: z.string().optional(),
        items: z.array(z.unknown()).optional()
      })
      .passthrough()
      .optional(),
    full_purchase_data: regiondoPurchaseDataSchema
  })
  .passthrough();

export const legacyRegiondoBookingSchema = z
  .object({
    id: regiondoIdentifierSchema,
    status: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    total_price: z.coerce.number().optional(),
    paid_amount: z.coerce.number().optional(),
    guest_count: z.coerce.number().int().positive().optional(),
    customer: z
      .object({
        id: regiondoIdentifierSchema.optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone_number: z.string().optional()
      })
      .passthrough()
      .optional(),
    location: z
      .object({
        id: regiondoIdentifierSchema.optional(),
        name: z.string().optional(),
        title: z.string().optional()
      })
      .passthrough()
      .optional(),
    product: z
      .object({
        id: regiondoIdentifierSchema.optional(),
        price: z.coerce.number().optional(),
        title: z.string().optional()
      })
      .passthrough()
      .optional(),
    products: z
      .array(
        z
          .object({
            id: regiondoIdentifierSchema.optional(),
            quantity: z.coerce.number().int().positive().optional(),
            price: z.coerce.number().optional(),
            title: z.string().optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

export const regiondoWebhookPayloadSchema = z.union([regiondoPurchaseDataPushSchema, legacyRegiondoBookingSchema]);

export const regiondoSupplierBookingSchema = z
  .object({
    booking_key: z.string().min(1),
    order_number: regiondoIdentifierSchema,
    status: z.string().optional(),
    event_date_time: z.string().optional(),
    date_applied_for: z.string().optional(),
    duration_type: z.string().optional(),
    duration_value: z.coerce.number().optional(),
    qty: z.coerce.number().int().nonnegative().optional(),
    qty_cancelled: z.coerce.number().int().nonnegative().optional(),
    product_id: regiondoIdentifierSchema.optional(),
    product_name: z.string().optional(),
    ticket_name: z.string().optional(),
    option_name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone_number: z.string().optional(),
    email: z.string().optional(),
    contact_data: regiondoContactDataSchema.optional()
  })
  .passthrough();

export const regiondoSupplierBookingsSchema = z.array(regiondoSupplierBookingSchema);

export type RegiondoCatalogVariationOption = z.infer<typeof regiondoCatalogVariationOptionSchema>;
export type RegiondoCatalogVariation = z.infer<typeof regiondoCatalogVariationSchema>;
export type RegiondoCatalogProduct = z.infer<typeof regiondoCatalogProductSchema>;
export type RegiondoPurchaseDataPush = z.infer<typeof regiondoPurchaseDataPushSchema>;
export type LegacyRegiondoBooking = z.infer<typeof legacyRegiondoBookingSchema>;
export type RegiondoWebhookPayload = z.infer<typeof regiondoWebhookPayloadSchema>;
export type RegiondoPurchaseData = z.infer<typeof regiondoPurchaseDataSchema>;
export type RegiondoSoldItem = z.infer<typeof regiondoSoldItemSchema>;
export type RegiondoSupplierBooking = z.infer<typeof regiondoSupplierBookingSchema>;
