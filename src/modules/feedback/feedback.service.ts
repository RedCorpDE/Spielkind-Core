import { ConflictHttpError, ForbiddenHttpError, HttpError, ValidationHttpError } from '../../http/errors.js';
import type { BookingFeedback } from './feedback.types.js';
import type { ParsedCreateBookingFeedbackInput } from './feedback.schemas.js';
import {
  getClientBookingFeedback,
  getClientFeedbackBookingAccess,
  insertClientBookingFeedback
} from './feedback.repository.js';

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function readClientBookingFeedback(
  bookingId: string,
  clientId: string
): Promise<{ feedback: BookingFeedback | null; eligible: boolean }> {
  const access = await getClientFeedbackBookingAccess(bookingId, clientId);
  if (!access.exists || !access.visible) throw new HttpError(404, 'Booking was not found.');
  const feedback = await getClientBookingFeedback(bookingId, clientId);
  return {
    feedback,
    eligible: access.directlyIncluded && access.ended && !feedback
  };
}

export async function submitClientBookingFeedback(
  bookingId: string,
  clientId: string,
  input: ParsedCreateBookingFeedbackInput
): Promise<BookingFeedback> {
  const access = await getClientFeedbackBookingAccess(bookingId, clientId);
  if (!access.exists || !access.visible) throw new HttpError(404, 'Booking was not found.');
  if (!access.directlyIncluded) {
    throw new ForbiddenHttpError('Only clients included in this booking can submit feedback.');
  }
  if (!access.ended) {
    throw new ValidationHttpError('Feedback can only be submitted after the booking has ended.');
  }
  if (await getClientBookingFeedback(bookingId, clientId)) {
    throw new ConflictHttpError('Feedback has already been submitted for this booking.');
  }
  try {
    return await insertClientBookingFeedback(bookingId, clientId, input);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictHttpError('Feedback has already been submitted for this booking.');
    }
    throw error;
  }
}
