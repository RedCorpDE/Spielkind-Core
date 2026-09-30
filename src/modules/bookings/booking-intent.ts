export type BookingProviderType = 'core' | 'regiondo';

export type TimeSelectionMode = 'date_range' | 'start_end' | 'start_duration' | 'fixed_duration';

export interface BookingIntentOption {
  optionId: string;
  value?: string;
  quantity?: number;
}

export interface BookingIntent {
  locationId: string;
  productId: string;
  locationProductId: string;
  variantId?: string;
  startAt: string;
  endAt: string;
  participants?: number;
  options?: BookingIntentOption[];
  quantities?: Record<string, number>;
  discountCode?: string;
}

export interface OfferingBookingRules {
  timeSelectionMode: TimeSelectionMode;
  timezone: string;
  minParticipants: number;
  maxParticipants: number;
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
  durationStepMinutes: number | null;
  defaultDurationMinutes: number | null;
  allowedDurationMinutes: number[];
  minAdvanceMinutes: number;
  maxAdvanceDays: number | null;
  sameDayBookingAllowed: boolean;
}

export interface BookingOffering {
  id: string;
  locationId: string;
  productId: string;
  active: boolean;
  bookingProvider: BookingProviderType;
  rules: OfferingBookingRules;
}

export function participantCount(intent: BookingIntent): number {
  return intent.participants ?? intent.quantities?.participants ?? 1;
}

