export interface DashboardUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface DashboardAdminUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  canAccessDashboard: boolean;
  lastLoginAt: string | null;
}

export interface CreateDashboardAdminUserInput {
  email: string;
  displayName: string;
  role: string;
  password: string;
  isActive?: boolean;
  canAccessDashboard?: boolean;
}

export interface UpdateDashboardAdminUserInput {
  email?: string;
  displayName?: string;
  role?: string;
  password?: string;
  isActive?: boolean;
  canAccessDashboard?: boolean;
}

export interface DashboardLocation {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  regiondoLocationId: string | null;
  isSystemPlaceholder: boolean;
  providerDataStatus: 'known' | 'unknown';
  createdAt: string;
  updatedAt: string;
}

export interface CreateDashboardLocationInput {
  title: string;
  description?: string;
  imageUrl?: string | null;
  regiondoLocationId?: string | null;
}

export interface UpdateDashboardLocationInput {
  title?: string;
  description?: string;
  imageUrl?: string | null;
  regiondoLocationId?: string | null;
}

export interface DashboardTaskColumn {
  id: string;
  title: string;
  bookingRelated: boolean;
  position: number;
}

export interface CreateDashboardTaskColumnInput {
  title: string;
  bookingRelated: boolean;
  position?: number;
}

export interface UpdateDashboardTaskColumnInput {
  title?: string;
  bookingRelated?: boolean;
  position?: number;
}

export interface ReorderDashboardTaskColumnsInput {
  orderedColumnIds: string[];
}

export type DashboardTaskStatus = string;
export type DashboardTaskRawJsonValue = string | number | boolean | null | string[];
export type DashboardTaskRawJson = Record<string, DashboardTaskRawJsonValue | undefined>;

export interface DashboardTaskActivityActor {
  name: string;
  role: string;
  source: 'user' | 'system' | 'external' | (string & {});
}

export interface DashboardTaskActivityChange {
  field: string;
  from?: string;
  to?: string;
}

export interface DashboardTaskActivityEntry {
  id: string;
  actor: DashboardTaskActivityActor;
  changes: DashboardTaskActivityChange[];
  metadata?: Record<string, boolean | number | string | null>;
  occurredAt: string;
  type: string;
}

export interface DashboardTaskOwner {
  id: string;
  name: string;
  role: string;
}

export interface DashboardTask {
  id: string;
  title: string;
  description: string;
  status: DashboardTaskStatus;
  eventDateTime: string | null;
  reminderDate: string | null;
  reservedCapacityDate: string | null;
  owner: DashboardTaskOwner;
  rawJson: DashboardTaskRawJson;
  site: string;
  createdAt: string;
  updatedAt: string;
  activityLog: DashboardTaskActivityEntry[];
  columnId: string;
  columnTitle: string;
  columnPosition: number;
  bookingRelated: boolean;
  connectedBookingId: string | null;
}

export type DashboardBookingExternalStatus =
  | 'Pending'
  | 'Processing'
  | 'Confirmed'
  | 'Completed'
  | 'Rejected'
  | 'Canceled'
  | 'Unknown';

export type DashboardBookingOpsStatus = 'Normal' | 'Escalated';

export type DashboardBookingStatus = DashboardBookingExternalStatus | 'Escalated';

export type DashboardBookingSort = 'bookingDate' | 'lastUpdated';

export type DashboardSortDirection = 'asc' | 'desc';

export type DashboardRegiondoWebhookEventStatus =
  | 'pending'
  | 'processing'
  | 'retrying'
  | 'processed'
  | 'dead_letter';

export interface DashboardBooking {
  id: string;
  familyName: string;
  childName: string;
  customerDataStatus: 'known' | 'unknown';
  experience: string;
  bookingDate: string;
  status: DashboardBookingStatus;
  externalStatus: DashboardBookingExternalStatus;
  opsStatus: DashboardBookingOpsStatus;
  contactEmail: string;
  attendees: number;
  source: string;
  specialRequirements: string;
  depositPaid: boolean;
  opsNotes: string;
  locationId: string | null;
  locationTitle: string;
  locationDataStatus: 'known' | 'unknown';
  regiondoBookingId: string | null;
  regiondoOrderNumber: string | null;
  lastUpdated: string;
}

export interface DashboardBookingProduct {
  productId: string;
  regiondoProductId: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
}

export interface DashboardBookingContactDetails {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phoneNumber: string | null;
}

export interface DashboardBookingPaymentDetails {
  amountToPay: number;
  amountPaid: number;
  amountOutstanding: number;
  paymentMethod: string | null;
}

export interface DashboardBookingRegiondoSelection {
  id: string;
  quantity: number;
  productId: string | null;
  regiondoProductId: string | null;
  productTitle: string;
  variationLabel: string | null;
  optionValueLabel: string | null;
}

export interface DashboardBookingDrawerData {
  contact: DashboardBookingContactDetails;
  payment: DashboardBookingPaymentDetails;
  regiondoSelections: DashboardBookingRegiondoSelection[];
}

export interface DashboardBookingSyncInfo {
  lastCanonicalSnapshotAt: string | null;
  latestEventId: string | null;
  latestEventStatus: DashboardRegiondoWebhookEventStatus | null;
  latestEventActionType: string | null;
  latestEventChannel: string | null;
  latestEventCreatedAt: string | null;
  latestEventProviderSnapshotAt: string | null;
  latestEventAvailableAt: string | null;
  latestEventProcessedAt: string | null;
  latestEventAttemptCount: number;
  lastSyncError: string | null;
  isQueued: boolean;
  isStale: boolean;
}

export interface DashboardBookingDetail extends DashboardBooking {
  products: DashboardBookingProduct[];
  drawerData: DashboardBookingDrawerData;
  sync: DashboardBookingSyncInfo;
}

export interface DashboardBookingActivityEntry {
  id: string;
  type: 'sync_event' | 'ops_update' | 'reconcile_request';
  title: string;
  description: string;
  occurredAt: string;
  status?: string | null;
  actor?: {
    id: string | null;
    name: string;
    role: string | null;
    source: 'user' | 'system' | 'external';
  };
  metadata?: Record<string, boolean | number | string | null>;
}

export interface DashboardPaginatedBookingsResponse {
  items: DashboardBooking[];
  nextCursor: string | null;
}

export interface DashboardRegiondoSyncSummary {
  pending: number;
  processing: number;
  retrying: number;
  deadLetter: number;
  processedLast24h: number;
  oldestPendingCreatedAt: string | null;
  oldestPendingAgeSeconds: number | null;
  latestProcessedAt: string | null;
}

export interface DashboardRegiondoWebhookEvent {
  eventId: string;
  canonicalBookingId: string | null;
  bookingKey: string;
  orderNumber: string | null;
  actionType: string | null;
  channel: string | null;
  payloadKind: 'purchase_data_push' | 'legacy_booking_event' | 'unknown';
  status: DashboardRegiondoWebhookEventStatus;
  attemptCount: number;
  lastError: string | null;
  providerSnapshotAt: string | null;
  availableAt: string;
  lockedAt: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardPaginatedRegiondoWebhookEventsResponse {
  items: DashboardRegiondoWebhookEvent[];
  nextCursor: string | null;
}

export interface DashboardTaskMutationActor {
  name: string;
  role: string;
  source?: 'user' | 'system' | 'external' | (string & {});
}

export interface CreateDashboardTaskInput {
  title: string;
  description: string;
  eventDateTime: string;
  reminderDate?: string | null;
  reservedCapacityDate?: string | null;
  ownerId?: string | null;
  rawJson?: DashboardTaskRawJson;
  site: string;
  columnId?: string | null;
  connectedBookingId?: string | null;
}

export interface UpdateDashboardTaskInput {
  title: string;
  description: string;
  eventDateTime: string;
  reminderDate?: string | null;
  reservedCapacityDate?: string | null;
  ownerId?: string | null;
  rawJson?: DashboardTaskRawJson;
  site: string;
  columnId: string | null;
  connectedBookingId?: string | null;
}

export interface UpdateDashboardBookingInput {
  opsStatus?: DashboardBookingOpsStatus;
  opsNotes?: string;
}

export interface ListDashboardTasksFilters {
  columnId?: string;
  ownerId?: string;
  connectedBookingId?: string;
  search?: string;
  limit?: number;
}

export interface ListDashboardBookingsFilters {
  status?: DashboardBookingStatus;
  externalStatus?: DashboardBookingExternalStatus;
  opsStatus?: DashboardBookingOpsStatus;
  locationId?: string;
  search?: string;
  from?: string;
  to?: string;
  updatedSince?: string;
  cursor?: string;
  sort?: DashboardBookingSort;
  direction?: DashboardSortDirection;
  limit?: number;
}

export interface DashboardSummary {
  totalTasks: number;
  overdueTasks: number;
  totalBookings: number;
  pendingBookings: number;
  tasksByColumn: Array<{
    columnId: string;
    title: string;
    count: number;
  }>;
  bookingsByStatus: Array<{
    status: DashboardBookingStatus;
    count: number;
  }>;
}

export interface DashboardBootstrapResponse {
  me: DashboardUser;
  users: DashboardUser[];
  locations: DashboardLocation[];
  taskColumns: DashboardTaskColumn[];
  summary: DashboardSummary;
}
