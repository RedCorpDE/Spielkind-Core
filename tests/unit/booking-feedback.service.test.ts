import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookingFeedbackSchema } from '../../src/modules/feedback/feedback.schemas.js';
import {
  readClientBookingFeedback,
  submitClientBookingFeedback
} from '../../src/modules/feedback/feedback.service.js';
import {
  getClientBookingFeedback,
  getClientFeedbackBookingAccess,
  insertClientBookingFeedback
} from '../../src/modules/feedback/feedback.repository.js';

vi.mock('../../src/modules/feedback/feedback.repository.js', () => ({
  getClientBookingFeedback: vi.fn(),
  getClientFeedbackBookingAccess: vi.fn(),
  insertClientBookingFeedback: vi.fn()
}));

const bookingId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const feedback = {
  id: '33333333-3333-4333-8333-333333333333',
  bookingId,
  clientId,
  overallRating: 5,
  equipmentRating: 4,
  cleanlinessRating: null,
  internetRating: null,
  accessRating: null,
  valueRating: null,
  tags: ['great_equipment'] as const,
  comment: 'Great visit.',
  publicReviewConsent: false,
  submittedFrom: 'app' as const,
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z'
};

describe('booking feedback validation and service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a valid rating with optional detailed ratings and controlled tags', () => {
    const result = createBookingFeedbackSchema.safeParse({
      overallRating: 5,
      equipmentRating: 4,
      tags: ['great_equipment'],
      comment: 'Great visit.'
    });
    expect(result.success).toBe(true);
  });

  it.each([
    { overallRating: 0 },
    { overallRating: 6 },
    { overallRating: 4, internetRating: 9 },
    { overallRating: 4, tags: ['arbitrary'] },
    { overallRating: 4, comment: 'x'.repeat(2001) }
  ])('rejects invalid feedback input %#', (input) => {
    expect(createBookingFeedbackSchema.safeParse(input).success).toBe(false);
  });

  it('submits feedback for an ended booking containing the client', async () => {
    vi.mocked(getClientFeedbackBookingAccess).mockResolvedValue({
      exists: true, visible: true, directlyIncluded: true, ended: true, status: 'completed'
    });
    vi.mocked(getClientBookingFeedback).mockResolvedValue(null);
    vi.mocked(insertClientBookingFeedback).mockResolvedValue(feedback);
    await expect(submitClientBookingFeedback(bookingId, clientId, {
      overallRating: 5,
      equipmentRating: 4,
      tags: ['great_equipment'],
      publicReviewConsent: false
    })).resolves.toEqual(feedback);
  });

  it('rejects active or future bookings', async () => {
    vi.mocked(getClientFeedbackBookingAccess).mockResolvedValue({
      exists: true, visible: true, directlyIncluded: true, ended: false, status: 'confirmed'
    });
    await expect(submitClientBookingFeedback(bookingId, clientId, {
      overallRating: 4, tags: [], publicReviewConsent: false
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a client who can view a group booking but is not included in it', async () => {
    vi.mocked(getClientFeedbackBookingAccess).mockResolvedValue({
      exists: true, visible: true, directlyIncluded: false, ended: true, status: 'completed'
    });
    await expect(submitClientBookingFeedback(bookingId, clientId, {
      overallRating: 4, tags: [], publicReviewConsent: false
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects duplicate feedback', async () => {
    vi.mocked(getClientFeedbackBookingAccess).mockResolvedValue({
      exists: true, visible: true, directlyIncluded: true, ended: true, status: 'completed'
    });
    vi.mocked(getClientBookingFeedback).mockResolvedValue(feedback);
    await expect(submitClientBookingFeedback(bookingId, clientId, {
      overallRating: 4, tags: [], publicReviewConsent: false
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('returns only the authenticated client feedback and eligibility state', async () => {
    vi.mocked(getClientFeedbackBookingAccess).mockResolvedValue({
      exists: true, visible: true, directlyIncluded: true, ended: true, status: 'completed'
    });
    vi.mocked(getClientBookingFeedback).mockResolvedValue(feedback);
    await expect(readClientBookingFeedback(bookingId, clientId)).resolves.toEqual({
      feedback,
      eligible: false
    });
  });
});
