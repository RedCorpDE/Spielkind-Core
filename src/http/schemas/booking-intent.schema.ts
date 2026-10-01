import { z } from 'zod';

const uuid = z.string().uuid();

export const bookingIntentOptionSchema = z.object({
  optionId: uuid,
  value: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().int().positive().max(100).optional()
});

export const bookingIntentSchema = z.object({
  locationId: uuid,
  productId: uuid,
  locationProductId: uuid,
  variantId: uuid.optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  durationMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
  participants: z.number().int().positive().max(1000).optional(),
  options: z.array(bookingIntentOptionSchema).max(30).default([]),
  quantities: z.record(z.string().min(1).max(100), z.number().int().nonnegative().max(1000)).optional(),
  discountCode: z.string().trim().min(1).max(100).optional()
}).superRefine((value, context) => {
  if (new Date(value.endAt) <= new Date(value.startAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'endAt must be after startAt.' });
  }
  if (value.participants === undefined && value.quantities?.participants === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['participants'], message: 'participants is required.' });
  }
});

export type BookingIntentRequest = z.infer<typeof bookingIntentSchema>;

