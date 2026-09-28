import { pool } from '../../db/pool.js';
import { listBookings } from '../../dashboard/repository/bookings.js';
import type { DashboardPaginatedBookingsResponse, DashboardSortDirection } from '../../dashboard/types.js';

export type AdminClientAccountStatus = 'none' | 'unverified' | 'active';
export type AdminClientSort = 'name' | 'createdAt' | 'updatedAt' | 'lastActivityAt' | 'bookingCount';

export interface AdminClientContactMethod {
  contactMethodId: string;
  channel: 'email' | 'telegram' | 'sms' | 'whatsapp';
  destination: string;
  isEnabled: boolean;
  isVerified: boolean;
}

export interface AdminClientListItem {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  createdAt: string;
  updatedAt: string;
  bookingCount: number;
  upcomingBookingCount: number;
  groupCount: number;
  appAccountStatus: AdminClientAccountStatus;
  lastActivityAt: string;
}

export interface AdminClientGroupSummary {
  groupId: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  memberCount: number;
  joinedAt: string;
}

export interface AdminClientDeviceSummary {
  id: string;
  platform: 'ios' | 'android' | 'web';
  deviceName: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  notificationsEnabled: boolean;
  lastSeenAt: string | null;
  isActive: boolean;
}

export interface AdminClientDetail {
  id: string;
  clientId: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
  birthday: string | null;
  email: string | null;
  phoneNumber: string | null;
  preferredContactType: string | null;
  subscribedToNewsletter: boolean;
  regiondoCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
  contactMethods: AdminClientContactMethod[];
  appAccount: {
    hasAccount: boolean;
    emailVerified: boolean;
    providers: string[];
    activeSessionCount: number;
    lastLoginAt: string | null;
    status: AdminClientAccountStatus;
  };
  preferences: {
    locale: string;
    theme: string;
    bookingRemindersEnabled: boolean;
    accessNotificationsEnabled: boolean;
    groupNotificationsEnabled: boolean;
    marketingNotificationsEnabled: boolean;
  } | null;
  groups: AdminClientGroupSummary[];
  bookingSummary: { total: number; upcoming: number; past: number; cancelled: number };
  deviceSummary: { total: number; active: number };
  devices: AdminClientDeviceSummary[];
  lastActivityAt: string;
}

export interface ListAdminClientsFilters {
  search?: string;
  hasBookings?: boolean;
  hasUpcomingBookings?: boolean;
  hasAppAccount?: boolean;
  emailVerified?: boolean;
  createdFrom?: string;
  createdTo?: string;
  sort?: AdminClientSort;
  direction?: DashboardSortDirection;
  page?: number;
  limit?: number;
}

export interface AdminClientListResponse {
  items: AdminClientListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ClientListRow {
  client_id: string;
  first_name: string;
  last_name: string;
  display_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  booking_count: string | number;
  upcoming_booking_count: string | number;
  group_count: string | number;
  identity_count: string | number;
  email_verified: boolean | null;
  last_activity_at: Date | string;
  total_count: string | number;
}

interface ClientDetailRow {
  client_id: string;
  first_name: string;
  last_name: string;
  display_name: string | null;
  avatar_url: string | null;
  birthday: string | null;
  email: string | null;
  phone_number: string | null;
  preferred_contact_type: string | null;
  subscribed_to_newsletter: boolean;
  regiondo_customer_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  contact_methods: AdminClientContactMethod[] | null;
  app_account: AdminClientDetail['appAccount'];
  preferences: AdminClientDetail['preferences'];
  groups: AdminClientGroupSummary[] | null;
  booking_summary: AdminClientDetail['bookingSummary'];
  devices: AdminClientDeviceSummary[] | null;
  device_summary: AdminClientDetail['deviceSummary'];
  last_activity_at: Date | string;
}

function toIsoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toCount(value: string | number | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function getAccountStatus(identityCount: string | number, emailVerified: boolean | null): AdminClientAccountStatus {
  if (toCount(identityCount) === 0) return 'none';
  return emailVerified ? 'active' : 'unverified';
}

function mapClientListRow(row: ClientListRow): AdminClientListItem {
  return {
    id: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    primaryEmail: row.primary_email,
    primaryPhone: row.primary_phone,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    bookingCount: toCount(row.booking_count),
    upcomingBookingCount: toCount(row.upcoming_booking_count),
    groupCount: toCount(row.group_count),
    appAccountStatus: getAccountStatus(row.identity_count, row.email_verified),
    lastActivityAt: toIsoString(row.last_activity_at)
  };
}

function mapClientDetailRow(row: ClientDetailRow): AdminClientDetail {
  return {
    id: row.client_id,
    clientId: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    birthday: row.birthday,
    email: row.email,
    phoneNumber: row.phone_number,
    preferredContactType: row.preferred_contact_type,
    subscribedToNewsletter: row.subscribed_to_newsletter,
    regiondoCustomerId: row.regiondo_customer_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    contactMethods: row.contact_methods ?? [],
    appAccount: row.app_account,
    preferences: row.preferences,
    groups: row.groups ?? [],
    bookingSummary: row.booking_summary,
    deviceSummary: row.device_summary,
    devices: row.devices ?? [],
    lastActivityAt: toIsoString(row.last_activity_at)
  };
}

const listSortColumns: Record<AdminClientSort, string> = {
  name: `LOWER(COALESCE(NULLIF(c.display_name, ''), CONCAT_WS(' ', c.first_name, c.last_name)))`,
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
  lastActivityAt: 'last_activity_at',
  bookingCount: 'booking_count'
};

export async function listAdminClients(filters: ListAdminClientsFilters = {}): Promise<AdminClientListResponse> {
  const values: Array<boolean | number | string> = [];
  const where: string[] = [];
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  const sort = filters.sort ?? 'name';
  const direction = filters.direction ?? (sort === 'name' ? 'asc' : 'desc');

  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    const parameter = `$${values.length}`;
    where.push(`(
      c.client_id::text ILIKE ${parameter}
      OR c.first_name ILIKE ${parameter}
      OR c.last_name ILIKE ${parameter}
      OR COALESCE(c.display_name, '') ILIKE ${parameter}
      OR COALESCE(c.email::text, '') ILIKE ${parameter}
      OR COALESCE(c.phone_number, '') ILIKE ${parameter}
      OR EXISTS (
        SELECT 1 FROM client_contact_methods searched_contact
        WHERE searched_contact.client_id = c.client_id AND searched_contact.destination ILIKE ${parameter}
      )
    )`);
  }

  const addBooleanAggregateFilter = (value: boolean | undefined, expression: string) => {
    if (value === undefined) return;
    where.push(value ? expression : `NOT (${expression})`);
  };
  addBooleanAggregateFilter(filters.hasBookings, 'COALESCE(booking_stats.booking_count, 0) > 0');
  addBooleanAggregateFilter(filters.hasUpcomingBookings, 'COALESCE(booking_stats.upcoming_booking_count, 0) > 0');
  addBooleanAggregateFilter(filters.hasAppAccount, 'COALESCE(auth_stats.identity_count, 0) > 0');

  if (filters.emailVerified !== undefined) {
    where.push(filters.emailVerified ? 'COALESCE(auth_stats.email_verified, false)' : 'NOT COALESCE(auth_stats.email_verified, false)');
  }
  if (filters.createdFrom) {
    values.push(filters.createdFrom);
    where.push(`c.created_at >= $${values.length}::timestamptz`);
  }
  if (filters.createdTo) {
    values.push(filters.createdTo);
    where.push(`c.created_at <= $${values.length}::timestamptz`);
  }

  values.push(limit);
  const limitParameter = `$${values.length}`;
  values.push((page - 1) * limit);
  const offsetParameter = `$${values.length}`;
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const result = await pool.query<ClientListRow>(
    `SELECT
       c.client_id, c.first_name, c.last_name, c.display_name,
       COALESCE(c.email::text, primary_email.destination) AS primary_email,
       COALESCE(c.phone_number, primary_phone.destination) AS primary_phone,
       c.created_at, c.updated_at,
       COALESCE(booking_stats.booking_count, 0) AS booking_count,
       COALESCE(booking_stats.upcoming_booking_count, 0) AS upcoming_booking_count,
       COALESCE(group_stats.group_count, 0) AS group_count,
       COALESCE(auth_stats.identity_count, 0) AS identity_count,
       auth_stats.email_verified,
       GREATEST(c.updated_at, COALESCE(booking_stats.last_activity_at, c.updated_at),
         COALESCE(auth_stats.last_activity_at, c.updated_at), COALESCE(device_stats.last_activity_at, c.updated_at)) AS last_activity_at,
       COUNT(*) OVER() AS total_count
     FROM clients c
     LEFT JOIN LATERAL (
       SELECT destination FROM client_contact_methods
       WHERE client_id = c.client_id AND channel = 'email' AND is_enabled = true
       ORDER BY is_verified DESC, created_at ASC LIMIT 1
     ) primary_email ON true
     LEFT JOIN LATERAL (
       SELECT destination FROM client_contact_methods
       WHERE client_id = c.client_id AND channel IN ('sms', 'whatsapp') AND is_enabled = true
       ORDER BY is_verified DESC, created_at ASC LIMIT 1
     ) primary_phone ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS booking_count,
         COUNT(*) FILTER (WHERE dt_from >= NOW() AND LOWER(status) NOT IN ('cancelled', 'canceled')) AS upcoming_booking_count,
         MAX(updated_at) AS last_activity_at
       FROM bookings WHERE client_id = c.client_id
     ) booking_stats ON true
     LEFT JOIN LATERAL (SELECT COUNT(*) AS group_count FROM client_group_members WHERE client_id = c.client_id) group_stats ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT identity.id) AS identity_count,
         COALESCE(BOOL_OR(identity.email_verified_at IS NOT NULL), false) AS email_verified,
         MAX(COALESCE(session.last_used_at, session.created_at, identity.updated_at)) AS last_activity_at
       FROM client_auth_identities identity
       LEFT JOIN client_sessions session ON session.auth_identity_id = identity.id
       WHERE identity.client_id = c.client_id
     ) auth_stats ON true
     LEFT JOIN LATERAL (SELECT MAX(last_seen_at) AS last_activity_at FROM client_devices WHERE client_id = c.client_id) device_stats ON true
     ${whereClause}
     ORDER BY ${listSortColumns[sort]} ${direction.toUpperCase()}, c.client_id ASC
     LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
    values
  );

  const total = result.rows.length ? toCount(result.rows[0].total_count) : 0;
  return { items: result.rows.map(mapClientListRow), page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 };
}

export async function getAdminClient(clientId: string): Promise<AdminClientDetail | null> {
  const result = await pool.query<ClientDetailRow>(
    `SELECT
       c.client_id, c.first_name, c.last_name, c.display_name, c.avatar_url,
       c.birthday::text AS birthday, c.email::text AS email, c.phone_number,
       c.preferred_contact_type, c.subscribed_to_newsletter, c.regiondo_customer_id,
       c.created_at, c.updated_at, contacts.items AS contact_methods,
       jsonb_build_object(
         'hasAccount', COALESCE(auth.identity_count, 0) > 0,
         'emailVerified', COALESCE(auth.email_verified, false),
         'providers', COALESCE(auth.providers, '[]'::jsonb),
         'activeSessionCount', COALESCE(auth.active_session_count, 0),
         'lastLoginAt', auth.last_login_at,
         'status', CASE WHEN COALESCE(auth.identity_count, 0) = 0 THEN 'none'
           WHEN COALESCE(auth.email_verified, false) THEN 'active' ELSE 'unverified' END
       ) AS app_account,
       preferences.item AS preferences, groups.items AS groups,
       jsonb_build_object('total', COALESCE(booking_stats.total, 0), 'upcoming', COALESCE(booking_stats.upcoming, 0),
         'past', COALESCE(booking_stats.past, 0), 'cancelled', COALESCE(booking_stats.cancelled, 0)) AS booking_summary,
       devices.items AS devices,
       jsonb_build_object('total', COALESCE(devices.total, 0), 'active', COALESCE(devices.active, 0)) AS device_summary,
       GREATEST(c.updated_at, COALESCE(booking_stats.last_activity_at, c.updated_at),
         COALESCE(auth.last_activity_at, c.updated_at), COALESCE(devices.last_activity_at, c.updated_at)) AS last_activity_at
     FROM clients c
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'contactMethodId', method.contact_method_id, 'channel', method.channel, 'destination', method.destination,
         'isEnabled', method.is_enabled, 'isVerified', method.is_verified
       ) ORDER BY method.is_enabled DESC, method.is_verified DESC, method.created_at ASC) AS items
       FROM client_contact_methods method WHERE method.client_id = c.client_id
     ) contacts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT identity.id) AS identity_count,
         COALESCE(BOOL_OR(identity.email_verified_at IS NOT NULL), false) AS email_verified,
         jsonb_agg(DISTINCT identity.provider) FILTER (WHERE identity.provider IS NOT NULL) AS providers,
         COUNT(DISTINCT session.id) FILTER (WHERE session.revoked_at IS NULL AND session.expires_at > NOW()) AS active_session_count,
         MAX(COALESCE(session.last_used_at, session.created_at)) AS last_login_at,
         MAX(COALESCE(session.last_used_at, session.created_at, identity.updated_at)) AS last_activity_at
       FROM client_auth_identities identity
       LEFT JOIN client_sessions session ON session.auth_identity_id = identity.id
       WHERE identity.client_id = c.client_id
     ) auth ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_build_object('locale', preference.locale, 'theme', preference.theme,
         'bookingRemindersEnabled', preference.booking_reminders_enabled,
         'accessNotificationsEnabled', preference.access_notifications_enabled,
         'groupNotificationsEnabled', preference.group_notifications_enabled,
         'marketingNotificationsEnabled', preference.marketing_notifications_enabled) AS item
       FROM client_preferences preference WHERE preference.client_id = c.client_id
     ) preferences ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('groupId', membership.group_id, 'name', group_record.title,
         'role', membership.role, 'memberCount', (SELECT COUNT(*) FROM client_group_members counted WHERE counted.group_id = membership.group_id),
         'joinedAt', membership.joined_at) ORDER BY group_record.title ASC) AS items
       FROM client_group_members membership
       INNER JOIN client_groups group_record ON group_record.group_id = membership.group_id
       WHERE membership.client_id = c.client_id AND group_record.deleted_at IS NULL
     ) groups ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE booking.dt_from >= NOW() AND LOWER(booking.status) NOT IN ('cancelled', 'canceled')) AS upcoming,
         COUNT(*) FILTER (WHERE booking.dt_from < NOW() AND LOWER(booking.status) NOT IN ('cancelled', 'canceled')) AS past,
         COUNT(*) FILTER (WHERE LOWER(booking.status) IN ('cancelled', 'canceled')) AS cancelled,
         MAX(booking.updated_at) AS last_activity_at
       FROM bookings booking WHERE booking.client_id = c.client_id
     ) booking_stats ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', device.id, 'platform', device.platform,
         'deviceName', device.device_name, 'deviceModel', device.device_model, 'osVersion', device.os_version,
         'appVersion', device.app_version, 'notificationsEnabled', device.notifications_enabled,
         'lastSeenAt', device.last_seen_at, 'isActive', device.revoked_at IS NULL)
         ORDER BY device.last_seen_at DESC NULLS LAST, device.created_at DESC) AS items,
         COUNT(*) AS total, COUNT(*) FILTER (WHERE device.revoked_at IS NULL) AS active,
         MAX(device.last_seen_at) AS last_activity_at
       FROM client_devices device WHERE device.client_id = c.client_id
     ) devices ON true
     WHERE c.client_id = $1 LIMIT 1`,
    [clientId]
  );
  return result.rowCount ? mapClientDetailRow(result.rows[0]) : null;
}

export async function listAdminClientBookings(
  clientId: string,
  filters: { category?: 'all' | 'upcoming' | 'past' | 'cancelled'; cursor?: string; direction?: DashboardSortDirection; limit?: number } = {}
): Promise<DashboardPaginatedBookingsResponse | null> {
  const exists = await pool.query(`SELECT 1 FROM clients WHERE client_id = $1 LIMIT 1`, [clientId]);
  if (!exists.rowCount) return null;
  return listBookings({
    clientId,
    clientBookingCategory: filters.category ?? 'all',
    cursor: filters.cursor,
    direction: filters.direction,
    limit: filters.limit,
    sort: 'bookingDate'
  });
}

export async function updateAdminClient(
  clientId: string,
  input: {
    firstName?: string; lastName?: string; birthday?: string | null; email?: string | null;
    phoneNumber?: string | null; preferredContactType?: string | null; subscribedToNewsletter?: boolean;
    contactMethods?: Array<{ channel: 'email' | 'telegram' | 'sms' | 'whatsapp'; destination: string;
      isEnabled?: boolean; isVerified?: boolean; providerRef?: string | null; rawJson?: unknown }>;
  }
): Promise<AdminClientDetail | null> {
  const existing = await getAdminClient(clientId);
  if (!existing) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE clients SET first_name = $1, last_name = $2, birthday = $3::date, email = $4,
       phone_number = $5, preferred_contact_type = $6, subscribed_to_newsletter = $7 WHERE client_id = $8`,
      [input.firstName?.trim() || existing.firstName, input.lastName?.trim() || existing.lastName,
        input.birthday === undefined ? existing.birthday : input.birthday,
        input.email === undefined ? existing.email : input.email,
        input.phoneNumber === undefined ? existing.phoneNumber : input.phoneNumber,
        input.preferredContactType === undefined ? existing.preferredContactType : input.preferredContactType,
        input.subscribedToNewsletter ?? existing.subscribedToNewsletter, clientId]
    );
    if (input.contactMethods) {
      await client.query(`DELETE FROM client_contact_methods WHERE client_id = $1`, [clientId]);
      for (const method of input.contactMethods) {
        await client.query(
          `INSERT INTO client_contact_methods (client_id, channel, destination, is_enabled, is_verified, provider_ref, raw_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [clientId, method.channel, method.destination, method.isEnabled ?? true, method.isVerified ?? false,
            method.providerRef ?? null, JSON.stringify(method.rawJson ?? {})]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAdminClient(clientId);
}
