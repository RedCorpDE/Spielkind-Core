import { z } from 'zod';
import { BOOKING_FEEDBACK_TAGS } from './feedback.types.js';

const ratingSchema = z.number().int().min(1).max(5);

export const createBookingFeedbackSchema = z.object({
  overallRating: ratingSchema,
  equipmentRating: ratingSchema.optional(),
  cleanlinessRating: ratingSchema.optional(),
  internetRating: ratingSchema.optional(),
  accessRating: ratingSchema.optional(),
  valueRating: ratingSchema.optional(),
  tags: z.array(z.enum(BOOKING_FEEDBACK_TAGS)).max(15).default([]),
  comment: z.string().trim().max(2000).optional(),
  publicReviewConsent: z.boolean().default(false)
}).strict();

export const adminFeedbackListQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  bookingId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  overallRating: z.coerce.number().int().min(1).max(5).optional(),
  createdFrom: z.string().datetime({ offset: true }).optional(),
  createdTo: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100)
}).superRefine((value, context) => {
  if (value.createdFrom && value.createdTo && Date.parse(value.createdFrom) > Date.parse(value.createdTo)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'createdFrom must be before createdTo.', path: ['createdTo'] });
  }
});

export const feedbackStatsQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  bookingId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional()
}).superRefine((value, context) => {
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'from must be before to.', path: ['to'] });
  }
});

export type ParsedCreateBookingFeedbackInput = z.infer<typeof createBookingFeedbackSchema>;
export type AdminFeedbackListQuery = z.infer<typeof adminFeedbackListQuerySchema>;
export type FeedbackStatsQuery = z.infer<typeof feedbackStatsQuerySchema>;
