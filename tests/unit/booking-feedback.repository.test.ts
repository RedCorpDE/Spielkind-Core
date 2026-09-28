import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool.js';
import {
  getFeedbackStats,
  listAdminFeedback,
  listLocationFeedbackSummaries
} from '../../src/modules/feedback/feedback.repository.js';

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: vi.fn() }
}));

const feedbackRow = {
  feedback_id: '33333333-3333-4333-8333-333333333333',
  booking_id: '11111111-1111-4111-8111-111111111111',
  client_id: '22222222-2222-4222-8222-222222222222',
  overall_rating: 5,
  equipment_rating: null,
  cleanliness_rating: null,
  internet_rating: null,
  access_rating: null,
  value_rating: null,
  tags: ['clean'],
  comment: null,
  public_review_consent: false,
  submitted_from: 'app',
  created_at: '2026-09-26T10:00:00.000Z',
  updated_at: '2026-09-26T10:00:00.000Z',
  booking_reference: 'BK-123',
  booking_ends_at: '2026-09-25T20:00:00.000Z',
  client_display_name: 'Alex Player',
  location_id: '44444444-4444-4444-8444-444444444444',
  location_name: 'Braunschweig'
};

const statsRow = {
  average_overall_rating: '4.50',
  feedback_count: '2',
  average_equipment_rating: '4.00',
  average_cleanliness_rating: '5.00',
  average_internet_rating: null,
  average_access_rating: '4.50',
  average_value_rating: '4.00'
};

describe('booking feedback admin repository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies client, booking, location, rating, and date filters to the admin list', async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [feedbackRow], rowCount: 1 } as never);
    const items = await listAdminFeedback({
      clientId: feedbackRow.client_id,
      bookingId: feedbackRow.booking_id,
      locationId: feedbackRow.location_id,
      overallRating: 5,
      createdFrom: '2026-09-01T00:00:00.000Z',
      createdTo: '2026-09-30T23:59:59.000Z',
      limit: 25
    });
    const [sql, values] = vi.mocked(pool.query).mock.calls[0];
    expect(sql).toContain('feedback.client_id');
    expect(sql).toContain('feedback.booking_id');
    expect(sql).toContain('booking.location_id');
    expect(values).toEqual([
      feedbackRow.client_id,
      feedbackRow.booking_id,
      feedbackRow.location_id,
      5,
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T23:59:59.000Z',
      25
    ]);
    expect(items[0]).toMatchObject({ overallRating: 5, location: { name: 'Braunschweig' } });
  });

  it('maps aggregate statistics filtered by location and date range', async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [statsRow], rowCount: 1 } as never);
    await expect(getFeedbackStats({
      locationId: feedbackRow.location_id,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.000Z'
    })).resolves.toMatchObject({ averageOverallRating: 4.5, feedbackCount: 2 });
  });

  it('derives location summaries through feedback bookings and locations', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ ...statsRow, location_id: feedbackRow.location_id, location_name: 'Braunschweig' }],
      rowCount: 1
    } as never);
    const summaries = await listLocationFeedbackSummaries({});
    const [sql] = vi.mocked(pool.query).mock.calls[0];
    expect(sql).toContain('INNER JOIN bookings');
    expect(sql).toContain('INNER JOIN booking_feedback');
    expect(summaries[0]).toMatchObject({ locationName: 'Braunschweig', feedbackCount: 2 });
  });
});
