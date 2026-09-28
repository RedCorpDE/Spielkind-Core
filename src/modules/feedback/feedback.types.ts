export const BOOKING_FEEDBACK_TAGS = [
  'great_equipment',
  'fast_internet',
  'clean',
  'easy_access',
  'good_value',
  'comfortable',
  'would_visit_again',
  'equipment_issue',
  'internet_issue',
  'access_issue',
  'not_clean',
  'too_loud',
  'temperature',
  'booking_issue',
  'other'
] as const;

export type BookingFeedbackTag = (typeof BOOKING_FEEDBACK_TAGS)[number];
export type FeedbackSubmittedFrom = 'app' | 'web' | 'admin';

export interface BookingFeedback {
  id: string;
  bookingId: string;
  clientId: string;
  overallRating: number;
  equipmentRating: number | null;
  cleanlinessRating: number | null;
  internetRating: number | null;
  accessRating: number | null;
  valueRating: number | null;
  tags: BookingFeedbackTag[];
  comment: string | null;
  publicReviewConsent: boolean;
  submittedFrom: FeedbackSubmittedFrom;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBookingFeedbackInput {
  overallRating: number;
  equipmentRating?: number;
  cleanlinessRating?: number;
  internetRating?: number;
  accessRating?: number;
  valueRating?: number;
  tags?: BookingFeedbackTag[];
  comment?: string;
  publicReviewConsent?: boolean;
}

export interface AdminBookingFeedback extends BookingFeedback {
  booking: {
    id: string;
    reference: string;
    endsAt: string;
  };
  client: {
    id: string;
    displayName: string;
  };
  location: {
    id: string;
    name: string;
  };
}

export interface FeedbackStats {
  averageOverallRating: number | null;
  feedbackCount: number;
  averageEquipmentRating: number | null;
  averageCleanlinessRating: number | null;
  averageInternetRating: number | null;
  averageAccessRating: number | null;
  averageValueRating: number | null;
}

export interface LocationFeedbackSummary extends FeedbackStats {
  locationId: string;
  locationName: string;
}
