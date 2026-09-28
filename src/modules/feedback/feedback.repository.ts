import { pool } from '../../db/pool.js';
import type {
  AdminBookingFeedback,
  BookingFeedback,
  FeedbackStats,
  LocationFeedbackSummary
} from './feedback.types.js';
import type {
  AdminFeedbackListQuery,
  FeedbackStatsQuery,
  ParsedCreateBookingFeedbackInput
} from './feedback.schemas.js';

interface FeedbackRow {
  feedback_id: string;
  booking_id: string;
  client_id: string;
  overall_rating: number;
  equipment_rating: number | null;
  cleanliness_rating: number | null;
  internet_rating: number | null;
  access_rating: number | null;
  value_rating: number | null;
  tags: BookingFeedback['tags'];
  comment: string | null;
  public_review_consent: boolean;
  submitted_from: BookingFeedback['submittedFrom'];
  created_at: Date | string;
  updated_at: Date | string;
}

interface AdminFeedbackRow extends FeedbackRow {
  booking_reference: string;
  booking_ends_at: Date | string;
  client_display_name: string;
  location_id: string;
  location_name: string;
}

export interface ClientFeedbackBookingAccess {
  exists: boolean;
  visible: boolean;
  directlyIncluded: boolean;
  ended: boolean;
  status: string | null;
}

const feedbackColumns = `feedback.feedback_id, feedback.booking_id, feedback.client_id,
  feedback.overall_rating, feedback.equipment_rating, feedback.cleanliness_rating,
  feedback.internet_rating, feedback.access_rating, feedback.value_rating,
  feedback.tags, feedback.comment, feedback.public_review_consent,
  feedback.submitted_from, feedback.created_at, feedback.updated_at`;

const toIso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
const nullableAverage = (value: string | number | null) => value === null ? null : Number(value);

function mapFeedback(row: FeedbackRow): BookingFeedback {
  return {
    id: row.feedback_id,
    bookingId: row.booking_id,
    clientId: row.client_id,
    overallRating: Number(row.overall_rating),
    equipmentRating: row.equipment_rating === null ? null : Number(row.equipment_rating),
    cleanlinessRating: row.cleanliness_rating === null ? null : Number(row.cleanliness_rating),
    internetRating: row.internet_rating === null ? null : Number(row.internet_rating),
    accessRating: row.access_rating === null ? null : Number(row.access_rating),
    valueRating: row.value_rating === null ? null : Number(row.value_rating),
    tags: row.tags ?? [],
    comment: row.comment,
    publicReviewConsent: row.public_review_consent,
    submittedFrom: row.submitted_from,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapAdminFeedback(row: AdminFeedbackRow): AdminBookingFeedback {
  return {
    ...mapFeedback(row),
    booking: {
      id: row.booking_id,
      reference: row.booking_reference,
      endsAt: toIso(row.booking_ends_at)
    },
    client: { id: row.client_id, displayName: row.client_display_name },
    location: { id: row.location_id, name: row.location_name }
  };
}

export async function getClientFeedbackBookingAccess(
  bookingId: string,
  clientId: string
): Promise<ClientFeedbackBookingAccess> {
  const result = await pool.query<{
    visible: boolean;
    directly_included: boolean;
    ended: boolean;
    status: string;
  }>(
    `SELECT
       (
         booking.client_id = $2
         OR EXISTS (
           SELECT 1 FROM booking_participants participant
           WHERE participant.booking_id = booking.booking_id
             AND participant.client_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM client_group_members member
           WHERE member.group_id = booking.client_group_id
             AND member.client_id = $2
         )
       ) AS visible,
       (
         booking.client_id = $2
         OR EXISTS (
           SELECT 1 FROM booking_participants participant
           WHERE participant.booking_id = booking.booking_id
             AND participant.client_id = $2
             AND participant.status IN ('confirmed', 'checked_in')
         )
       ) AS directly_included,
       (
         booking.status = 'completed'
         OR (
           booking.dt_to <= NOW()
           AND booking.status NOT IN ('draft', 'cancelled', 'no_show')
         )
       ) AS ended,
       booking.status
     FROM bookings booking
     WHERE booking.booking_id = $1
     LIMIT 1`,
    [bookingId, clientId]
  );
  if (!result.rowCount) {
    return { exists: false, visible: false, directlyIncluded: false, ended: false, status: null };
  }
  const row = result.rows[0];
  return {
    exists: true,
    visible: row.visible,
    directlyIncluded: row.directly_included,
    ended: row.ended,
    status: row.status
  };
}

export async function getClientBookingFeedback(bookingId: string, clientId: string): Promise<BookingFeedback | null> {
  const result = await pool.query<FeedbackRow>(
    `SELECT ${feedbackColumns}
     FROM booking_feedback feedback
     WHERE feedback.booking_id = $1 AND feedback.client_id = $2
     LIMIT 1`,
    [bookingId, clientId]
  );
  return result.rowCount ? mapFeedback(result.rows[0]) : null;
}

export async function insertClientBookingFeedback(
  bookingId: string,
  clientId: string,
  input: ParsedCreateBookingFeedbackInput
): Promise<BookingFeedback> {
  const result = await pool.query<FeedbackRow>(
    `INSERT INTO booking_feedback (
       booking_id, client_id, overall_rating, equipment_rating, cleanliness_rating,
       internet_rating, access_rating, value_rating, tags, comment,
       public_review_consent, submitted_from
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, 'app')
     RETURNING feedback_id, booking_id, client_id, overall_rating, equipment_rating,
       cleanliness_rating, internet_rating, access_rating, value_rating, tags,
       comment, public_review_consent, submitted_from, created_at, updated_at`,
    [
      bookingId,
      clientId,
      input.overallRating,
      input.equipmentRating ?? null,
      input.cleanlinessRating ?? null,
      input.internetRating ?? null,
      input.accessRating ?? null,
      input.valueRating ?? null,
      input.tags,
      input.comment?.trim() || null,
      input.publicReviewConsent
    ]
  );
  return mapFeedback(result.rows[0]);
}

const adminFeedbackFrom = `FROM booking_feedback feedback
  INNER JOIN bookings booking ON booking.booking_id = feedback.booking_id
  INNER JOIN clients client ON client.client_id = feedback.client_id
  INNER JOIN locations location ON location.location_id = booking.location_id`;

const adminFeedbackSelect = `SELECT ${feedbackColumns},
  COALESCE(booking.regiondo_order_number, booking.regiondo_booking_id, LEFT(booking.booking_id::text, 8)) AS booking_reference,
  booking.dt_to AS booking_ends_at,
  COALESCE(client.display_name, NULLIF(TRIM(CONCAT_WS(' ', client.first_name, client.last_name)), ''), client.first_name) AS client_display_name,
  location.location_id, location.title AS location_name
  ${adminFeedbackFrom}`;

export async function listAdminFeedback(filters: AdminFeedbackListQuery): Promise<AdminBookingFeedback[]> {
  const values: Array<string | number> = [];
  const where: string[] = [];
  const add = (value: string | number, expression: (parameter: string) => string) => {
    values.push(value);
    where.push(expression(`$${values.length}`));
  };
  if (filters.clientId) add(filters.clientId, (parameter) => `feedback.client_id = ${parameter}::uuid`);
  if (filters.bookingId) add(filters.bookingId, (parameter) => `feedback.booking_id = ${parameter}::uuid`);
  if (filters.locationId) add(filters.locationId, (parameter) => `booking.location_id = ${parameter}::uuid`);
  if (filters.overallRating) add(filters.overallRating, (parameter) => `feedback.overall_rating = ${parameter}`);
  if (filters.createdFrom) add(filters.createdFrom, (parameter) => `feedback.created_at >= ${parameter}::timestamptz`);
  if (filters.createdTo) add(filters.createdTo, (parameter) => `feedback.created_at <= ${parameter}::timestamptz`);
  values.push(filters.limit);
  const result = await pool.query<AdminFeedbackRow>(
    `${adminFeedbackSelect}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY feedback.created_at DESC, feedback.feedback_id DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapAdminFeedback);
}

export async function getAdminFeedback(feedbackId: string): Promise<AdminBookingFeedback | null> {
  const result = await pool.query<AdminFeedbackRow>(
    `${adminFeedbackSelect}
     WHERE feedback.feedback_id = $1
     LIMIT 1`,
    [feedbackId]
  );
  return result.rowCount ? mapAdminFeedback(result.rows[0]) : null;
}

function statsWhere(filters: FeedbackStatsQuery) {
  const values: string[] = [];
  const where: string[] = [];
  const add = (value: string, expression: (parameter: string) => string) => {
    values.push(value);
    where.push(expression(`$${values.length}`));
  };
  if (filters.locationId) add(filters.locationId, (parameter) => `booking.location_id = ${parameter}::uuid`);
  if (filters.clientId) add(filters.clientId, (parameter) => `feedback.client_id = ${parameter}::uuid`);
  if (filters.bookingId) add(filters.bookingId, (parameter) => `feedback.booking_id = ${parameter}::uuid`);
  if (filters.from) add(filters.from, (parameter) => `feedback.created_at >= ${parameter}::timestamptz`);
  if (filters.to) add(filters.to, (parameter) => `feedback.created_at <= ${parameter}::timestamptz`);
  return { values, sql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

interface StatsRow {
  average_overall_rating: string | number | null;
  feedback_count: string | number;
  average_equipment_rating: string | number | null;
  average_cleanliness_rating: string | number | null;
  average_internet_rating: string | number | null;
  average_access_rating: string | number | null;
  average_value_rating: string | number | null;
}

function mapStats(row: StatsRow): FeedbackStats {
  return {
    averageOverallRating: nullableAverage(row.average_overall_rating),
    feedbackCount: Number(row.feedback_count),
    averageEquipmentRating: nullableAverage(row.average_equipment_rating),
    averageCleanlinessRating: nullableAverage(row.average_cleanliness_rating),
    averageInternetRating: nullableAverage(row.average_internet_rating),
    averageAccessRating: nullableAverage(row.average_access_rating),
    averageValueRating: nullableAverage(row.average_value_rating)
  };
}

const statsColumns = `ROUND(AVG(feedback.overall_rating)::numeric, 2) AS average_overall_rating,
  COUNT(*) AS feedback_count,
  ROUND(AVG(feedback.equipment_rating)::numeric, 2) AS average_equipment_rating,
  ROUND(AVG(feedback.cleanliness_rating)::numeric, 2) AS average_cleanliness_rating,
  ROUND(AVG(feedback.internet_rating)::numeric, 2) AS average_internet_rating,
  ROUND(AVG(feedback.access_rating)::numeric, 2) AS average_access_rating,
  ROUND(AVG(feedback.value_rating)::numeric, 2) AS average_value_rating`;

export async function getFeedbackStats(filters: FeedbackStatsQuery): Promise<FeedbackStats> {
  const where = statsWhere(filters);
  const result = await pool.query<StatsRow>(
    `SELECT ${statsColumns}
     FROM booking_feedback feedback
     INNER JOIN bookings booking ON booking.booking_id = feedback.booking_id
     ${where.sql}`,
    where.values
  );
  return mapStats(result.rows[0]);
}

export async function listLocationFeedbackSummaries(
  filters: Omit<FeedbackStatsQuery, 'locationId' | 'clientId' | 'bookingId'>
): Promise<LocationFeedbackSummary[]> {
  const where = statsWhere(filters);
  const result = await pool.query<StatsRow & { location_id: string; location_name: string }>(
    `SELECT location.location_id, location.title AS location_name, ${statsColumns}
     FROM locations location
     INNER JOIN bookings booking ON booking.location_id = location.location_id
     INNER JOIN booking_feedback feedback ON feedback.booking_id = booking.booking_id
     ${where.sql}
     GROUP BY location.location_id, location.title
     ORDER BY location.title ASC`,
    where.values
  );
  return result.rows.map((row) => ({
    locationId: row.location_id,
    locationName: row.location_name,
    ...mapStats(row)
  }));
}
