export type BookingProviderType = 'core' | 'regiondo';

export type TimeSelectionMode = 'date_range' | 'start_end' | 'start_duration' | 'fixed_duration';
export type PricingMode = 'once' | 'per_quantity' | 'per_date_unit' | 'per_date_unit_per_quantity';
export type DateRangeBillingUnit = 'nights' | 'calendar_days';

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
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  /** Customer-selected duration for start_duration products. Core resolves the final interval. */
  durationMinutes?: number;
  participants?: number;
  options?: BookingIntentOption[];
  quantities?: Record<string, number>;
  discountCode?: string;
}

export interface OfferingBookingRules {
  timeSelectionMode: TimeSelectionMode;
  timezone: string;
  fixedStartTime?: string | null;
  fixedEndTime?: string | null;
  earliestStartTime?: string | null;
  latestStartTime?: string | null;
  startIntervalMinutes?: number;
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
  pricingMode: PricingMode;
  dateRangeBillingUnit: DateRangeBillingUnit;
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

