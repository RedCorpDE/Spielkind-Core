import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { hashClientToken } from './tokens.js';
import type { ClientProfile } from './types.js';

export interface ClientLocation {
  id: string;
  name: string;
  address: string;
  city: string;
  postalCode: string;
  countryCode: string;
  lat: number;
  lng: number;
  description: string;
  imageUrls: string[];
  directions?: string;
  parking?: string;
  publicTransport?: string;
  facilities: string[];
  houseRules: string[];
  contactEmail?: string;
  contactPhone?: string;
  supportNote?: string;
}

export interface ClientBooking {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: 'pending' | 'confirmed' | 'active' | 'completed' | 'cancelled' | 'refunded';
  reference: string;
  location: ClientLocation;
  product: { id: string; name: string; variant: null };
  participants: Array<{
    id: string;
    bookingId: string;
    clientId: string | null;
    displayName: string;
    email: string | null;
    status: 'invited' | 'confirmed' | 'declined' | 'checked_in';
  }>;
  groupId: string | null;
  groupName: string | null;
  resources: Array<{ id: string; locationId: string; name: string; kind: string }>;
  paymentStatus: 'unpaid' | 'pending' | 'paid' | 'refunded' | 'failed';
  accessAvailableFrom: string | null;
}

interface LocationRow {
  location_id: string;
  title: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  description: string | null;
  image_url: string | null;
  image_urls: string[] | null;
  directions: string | null;
  parking: string | null;
  public_transport: string | null;
  facilities: string[] | null;
  house_rules: string[] | null;
  contact_email: string | null;
  contact_phone: string | null;
  support_note: string | null;
}

const locationColumns = `location.location_id, location.title, location.address, location.city,
  location.postal_code, location.country_code, location.latitude, location.longitude,
  location.description, location.image_url, location.image_urls, location.directions,
  location.parking, location.public_transport, location.facilities, location.house_rules,
  location.contact_email, location.contact_phone, location.support_note`;

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function mapLocation(row: LocationRow): ClientLocation {
  const images = row.image_urls ?? [];
  return defined({
    id: row.location_id,
    name: row.title,
    address: row.address ?? '',
    city: row.city ?? '',
    postalCode: row.postal_code ?? '',
    countryCode: row.country_code ?? 'DE',
    lat: Number(row.latitude ?? 0),
    lng: Number(row.longitude ?? 0),
    description: row.description ?? '',
    imageUrls: images.length ? images : row.image_url ? [row.image_url] : [],
    directions: row.directions ?? undefined,
    parking: row.parking ?? undefined,
    publicTransport: row.public_transport ?? undefined,
    facilities: row.facilities ?? [],
    houseRules: row.house_rules ?? [],
    contactEmail: row.contact_email ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    supportNote: row.support_note ?? undefined
  });
}

export async function listClientLocations(): Promise<ClientLocation[]> {
  const result = await pool.query<LocationRow>(
    `SELECT ${locationColumns}
     FROM locations location
     ORDER BY location.title ASC`
  );
  return result.rows.map(mapLocation);
}

export async function getClientLocation(locationId: string): Promise<ClientLocation | null> {
  const result = await pool.query<LocationRow>(
    `SELECT ${locationColumns}
     FROM locations location
     WHERE location.location_id = $1
     LIMIT 1`,
    [locationId]
  );
  return result.rowCount ? mapLocation(result.rows[0]) : null;
}

interface BookingRow extends LocationRow {
  booking_id: string;
  dt_from: string;
  dt_to: string;
  status: string;
  regiondo_booking_id: string | null;
  regiondo_order_number: string | null;
  total_amount: string | number;
  paid_amount: string | number;
  dashboard_data: Record<string, unknown> | null;
  client_group_id: string | null;
  group_title: string | null;
  owner_client_id: string;
  owner_display_name: string;
  owner_email: string | null;
  product: { id: string; name: string } | null;
  participants: ClientBooking['participants'] | null;
  resources: ClientBooking['resources'] | null;
  access_available_from: string | null;
}

function bookingStatus(row: BookingRow): ClientBooking['status'] {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'completed' || row.status === 'no_show') return 'completed';
  if (row.status === 'checked_in') return 'active';
  if (row.status === 'draft' || row.status === 'pending') return 'pending';
  const now = Date.now();
  if (new Date(row.dt_from).getTime() <= now && new Date(row.dt_to).getTime() > now) return 'active';
  return 'confirmed';
}

function paymentStatus(row: BookingRow): ClientBooking['paymentStatus'] {
  const total = Number(row.total_amount);
  const paid = Number(row.paid_amount);
  if (total > 0 && paid >= total) return 'paid';
  if (paid > 0) return 'pending';
  return 'unpaid';
}

function bookingTitle(row: BookingRow): string {
  const data = row.dashboard_data ?? {};
  const explicit = data.title;
  return typeof explicit === 'string' && explicit.trim() ? explicit : row.product?.name ?? row.group_title ?? row.title;
}

function mapBooking(row: BookingRow): ClientBooking {
  const participants = row.participants ?? [];
  if (!participants.some((participant) => participant.clientId === row.owner_client_id)) {
    participants.unshift({
      id: `owner-${row.booking_id}`,
      bookingId: row.booking_id,
      clientId: row.owner_client_id,
      displayName: row.owner_display_name,
      email: row.owner_email,
      status: row.status === 'checked_in' ? 'checked_in' : 'confirmed'
    });
  }
  return {
    id: row.booking_id,
    title: bookingTitle(row),
    startsAt: row.dt_from,
    endsAt: row.dt_to,
    status: bookingStatus(row),
    reference: row.regiondo_order_number ?? row.regiondo_booking_id ?? row.booking_id.slice(0, 8).toUpperCase(),
    location: mapLocation(row),
    product: row.product ? { ...row.product, variant: null } : { id: 'unassigned', name: 'Booking', variant: null },
    participants,
    groupId: row.client_group_id,
    groupName: row.group_title,
    resources: row.resources ?? [],
    paymentStatus: paymentStatus(row),
    accessAvailableFrom: row.access_available_from
  };
}

const bookingSelect = `SELECT
  booking.booking_id, booking.dt_from, booking.dt_to, booking.status,
  booking.regiondo_booking_id, booking.regiondo_order_number, booking.total_amount,
  booking.paid_amount, booking.dashboard_data, booking.client_group_id,
  owner.client_id AS owner_client_id,
  COALESCE(owner.display_name, NULLIF(TRIM(CONCAT_WS(' ', owner.first_name, owner.last_name)), ''), owner.first_name) AS owner_display_name,
  owner.email::text AS owner_email, group_record.title AS group_title,
  ${locationColumns},
  product_record.product,
  participant_record.participants,
  resource_record.resources,
  access_record.access_available_from
FROM bookings booking
INNER JOIN clients owner ON owner.client_id = booking.client_id
INNER JOIN locations location ON location.location_id = booking.location_id
LEFT JOIN client_groups group_record ON group_record.group_id = booking.client_group_id
LEFT JOIN LATERAL (
  SELECT jsonb_build_object('id', product.product_id, 'name', product.title) AS product
  FROM booking_products booking_product
  INNER JOIN products product ON product.product_id = booking_product.product_id
  WHERE booking_product.booking_id = booking.booking_id
  ORDER BY product.title ASC
  LIMIT 1
) product_record ON TRUE
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'id', participant.id,
    'bookingId', participant.booking_id,
    'clientId', participant.client_id,
    'displayName', participant.display_name,
    'email', participant.email,
    'status', participant.status
  ) ORDER BY participant.created_at ASC) AS participants
  FROM booking_participants participant
  WHERE participant.booking_id = booking.booking_id
) participant_record ON TRUE
LEFT JOIN LATERAL (
  SELECT jsonb_agg(DISTINCT jsonb_build_object(
    'id', resource.resource_id,
    'locationId', resource.location_id,
    'name', resource.title,
    'kind', CASE
      WHEN resource.type IN ('pc-room', 'console-room', 'bed-room') THEN 'room'
      WHEN resource.type = 'beverages' THEN 'equipment'
      ELSE resource.type
    END
  )) AS resources
  FROM consumptions consumption
  INNER JOIN resources resource ON resource.resource_id = consumption.resource_id
  WHERE consumption.booking_id = booking.booking_id
) resource_record ON TRUE
LEFT JOIN LATERAL (
  SELECT MIN(credential.valid_from)::text AS access_available_from
  FROM access_credentials credential
  LEFT JOIN booking_participants credential_participant ON credential_participant.id = credential.participant_id
  WHERE credential.booking_id = booking.booking_id
    AND (credential.client_id = $1 OR credential_participant.client_id = $1)
    AND credential.status IN ('pending', 'active')
) access_record ON TRUE`;

export async function listClientBookings(clientId: string): Promise<ClientBooking[]> {
  const result = await pool.query<BookingRow>(
    `${bookingSelect}
     WHERE booking.client_id = $1
       OR EXISTS (
         SELECT 1 FROM booking_participants visible_participant
         WHERE visible_participant.booking_id = booking.booking_id AND visible_participant.client_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM client_group_members visible_member
         WHERE visible_member.group_id = booking.client_group_id AND visible_member.client_id = $1
       )
     ORDER BY booking.dt_from DESC`,
    [clientId]
  );
  return result.rows.map(mapBooking);
}

export async function getClientBooking(clientId: string, bookingId: string): Promise<ClientBooking | null> {
  const result = await pool.query<BookingRow>(
    `${bookingSelect}
     WHERE booking.booking_id = $2
       AND (
         booking.client_id = $1
         OR EXISTS (
           SELECT 1 FROM booking_participants visible_participant
           WHERE visible_participant.booking_id = booking.booking_id AND visible_participant.client_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM client_group_members visible_member
           WHERE visible_member.group_id = booking.client_group_id AND visible_member.client_id = $1
         )
       )
     LIMIT 1`,
    [clientId, bookingId]
  );
  return result.rowCount ? mapBooking(result.rows[0]) : null;
}

interface AccessCredentialRow {
  id: string;
  booking_id: string;
  location_id: string;
  valid_from: string;
  valid_until: string;
  status: string;
  public_reference: string;
}

function mapAccessCredential(row: AccessCredentialRow) {
  const expired = new Date(row.valid_until).getTime() <= Date.now();
  const status = expired || row.status === 'expired'
    ? 'expired'
    : row.status === 'revoked' || row.status === 'disabled'
      ? 'revoked'
      : row.status === 'active'
        ? 'ready'
        : 'pending';
  return {
    id: row.id,
    bookingId: row.booking_id,
    locationId: row.location_id,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status,
    publicReference: row.public_reference
  } as const;
}

const accessSelect = `SELECT
  credential.id, credential.booking_id, booking.location_id,
  credential.valid_from, credential.valid_until, credential.status,
  COALESCE(credential.metadata ->> 'publicReference', credential.external_credential_id, credential.id::text) AS public_reference
FROM access_credentials credential
INNER JOIN bookings booking ON booking.booking_id = credential.booking_id
LEFT JOIN booking_participants participant ON participant.id = credential.participant_id
WHERE (credential.client_id = $1 OR participant.client_id = $1)`;

export async function getClientAccessCredential(clientId: string, bookingId?: string) {
  const result = await pool.query<AccessCredentialRow>(
    `${accessSelect}
     ${bookingId ? 'AND credential.booking_id = $2' : ''}
     ORDER BY
       CASE WHEN credential.valid_from <= NOW() AND credential.valid_until > NOW() THEN 0 ELSE 1 END,
       credential.valid_from ASC
     LIMIT 1`,
    bookingId ? [clientId, bookingId] : [clientId]
  );
  return result.rowCount ? mapAccessCredential(result.rows[0]) : null;
}

export async function getClientProfile(clientId: string): Promise<ClientProfile | null> {
  const result = await pool.query<{
    client_id: string; first_name: string; last_name: string; display_name: string; email: string;
    phone_number: string | null; avatar_url: string | null; email_verified_at: string | null;
    onboarding_completed_at: string | null;
  }>(
    `SELECT c.client_id, c.first_name, c.last_name,
            COALESCE(c.display_name, NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.first_name) AS display_name,
            c.email::text AS email,
            c.phone_number, c.avatar_url, identity.email_verified_at, preferences.onboarding_completed_at
     FROM clients c
     INNER JOIN client_auth_identities identity ON identity.client_id = c.client_id AND identity.provider = 'password'
     LEFT JOIN client_preferences preferences ON preferences.client_id = c.client_id
     WHERE c.client_id = $1 LIMIT 1`,
    [clientId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    emailVerified: Boolean(row.email_verified_at),
    onboardingCompleted: Boolean(row.onboarding_completed_at),
    avatarUrl: row.avatar_url,
    phone: row.phone_number
  };
}

export async function updateClientProfile(
  clientId: string,
  input: { firstName?: string; lastName?: string; displayName?: string; phone?: string | null }
): Promise<ClientProfile | null> {
  await pool.query(
    `UPDATE clients SET
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       display_name = COALESCE($4, display_name),
       phone_number = CASE WHEN $5::boolean THEN $6 ELSE phone_number END
     WHERE client_id = $1`,
    [clientId, input.firstName, input.lastName, input.displayName, input.phone !== undefined, input.phone]
  );
  return getClientProfile(clientId);
}

export async function getClientPreferences(clientId: string) {
  const result = await pool.query<{
    locale: string; theme: 'system' | 'light' | 'dark'; booking_reminders_enabled: boolean;
    access_notifications_enabled: boolean; group_notifications_enabled: boolean;
    marketing_notifications_enabled: boolean; onboarding_completed_at: string | null;
  }>(
    `INSERT INTO client_preferences (client_id) VALUES ($1)
     ON CONFLICT (client_id) DO UPDATE SET client_id = EXCLUDED.client_id
     RETURNING locale, theme, booking_reminders_enabled, access_notifications_enabled,
               group_notifications_enabled, marketing_notifications_enabled, onboarding_completed_at`,
    [clientId]
  );
  const row = result.rows[0];
  return {
    language: row.locale.toLowerCase().startsWith('en') ? 'en' : 'de',
    appearance: row.theme,
    onboardingCompleted: Boolean(row.onboarding_completed_at),
    bookingReminders: row.booking_reminders_enabled,
    accessNotifications: row.access_notifications_enabled,
    groupNotifications: row.group_notifications_enabled,
    marketing: row.marketing_notifications_enabled
  } as const;
}

export async function updateClientPreferences(clientId: string, input: {
  language?: 'de' | 'en'; appearance?: 'system' | 'light' | 'dark'; onboardingCompleted?: boolean;
  bookingReminders?: boolean; accessNotifications?: boolean; groupNotifications?: boolean; marketing?: boolean;
}) {
  await pool.query(
    `INSERT INTO client_preferences (client_id) VALUES ($1)
     ON CONFLICT (client_id) DO UPDATE SET
       locale = COALESCE($2, client_preferences.locale),
       theme = COALESCE($3, client_preferences.theme),
       onboarding_completed_at = CASE
         WHEN $4::boolean IS TRUE THEN COALESCE(client_preferences.onboarding_completed_at, NOW())
         WHEN $4::boolean IS FALSE THEN NULL
         ELSE client_preferences.onboarding_completed_at
       END,
       booking_reminders_enabled = COALESCE($5, client_preferences.booking_reminders_enabled),
       access_notifications_enabled = COALESCE($6, client_preferences.access_notifications_enabled),
       group_notifications_enabled = COALESCE($7, client_preferences.group_notifications_enabled),
       marketing_notifications_enabled = COALESCE($8, client_preferences.marketing_notifications_enabled),
       updated_at = NOW()`,
    [
      clientId,
      input.language ? `${input.language}-${input.language === 'de' ? 'DE' : 'GB'}` : null,
      input.appearance ?? null,
      input.onboardingCompleted ?? null,
      input.bookingReminders ?? null,
      input.accessNotifications ?? null,
      input.groupNotifications ?? null,
      input.marketing ?? null
    ]
  );
  return getClientPreferences(clientId);
}

export async function listClientPayments(clientId: string) {
  const result = await pool.query<{ payment_id: string; booking_id: string; amount: string | number }>(
    `SELECT payment.payment_id, payment.booking_id, payment.amount
     FROM payments payment
     INNER JOIN bookings booking ON booking.booking_id = payment.booking_id
     WHERE booking.client_id = $1
        OR EXISTS (
          SELECT 1 FROM booking_participants participant
          WHERE participant.booking_id = booking.booking_id AND participant.client_id = $1
        )
     ORDER BY payment.created_at DESC`,
    [clientId]
  );
  return result.rows.map((row) => ({
    id: row.payment_id,
    bookingId: row.booking_id,
    amount: Math.round(Number(row.amount) * 100),
    currency: 'EUR',
    status: 'paid' as const,
    invoiceUrl: null
  }));
}

export async function listClientConnectedAccounts(clientId: string) {
  const result = await pool.query<{ id: string; provider: string; display_name: string | null; connected_at: string }>(
    `SELECT id, provider, display_name, connected_at
     FROM client_connected_accounts
     WHERE client_id = $1
     ORDER BY connected_at DESC`,
    [clientId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    displayName: row.display_name ?? row.provider,
    connectedAt: row.connected_at
  }));
}

interface GroupRow {
  group_id: string;
  title: string;
  description: string;
  avatar_url: string | null;
  role: 'owner' | 'admin' | 'member';
  member_count: string | number;
}

export interface ClientGroup {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  memberCount: number;
  currentClientRole: 'owner' | 'admin' | 'member';
  members: Awaited<ReturnType<typeof listClientGroupMembers>>;
  upcomingBooking?: ClientBooking | null;
}

export async function listClientGroupMembers(groupId: string) {
  const result = await pool.query<{
    id: string; client_id: string; display_name: string; avatar_url: string | null;
    role: 'owner' | 'admin' | 'member'; joined_at: string;
  }>(
    `SELECT member.id, member.client_id,
            COALESCE(client.display_name, NULLIF(TRIM(CONCAT_WS(' ', client.first_name, client.last_name)), ''), client.first_name) AS display_name,
            client.avatar_url, member.role, member.joined_at
     FROM client_group_members member
     INNER JOIN clients client ON client.client_id = member.client_id
     WHERE member.group_id = $1
     ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, member.joined_at ASC`,
    [groupId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    joinedAt: row.joined_at
  }));
}

async function mapGroup(row: GroupRow, clientId: string): Promise<ClientGroup> {
  const [members, bookings] = await Promise.all([listClientGroupMembers(row.group_id), listClientBookings(clientId)]);
  const upcoming = bookings
    .filter((booking) => booking.groupId === row.group_id && new Date(booking.endsAt).getTime() > Date.now())
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0] ?? null;
  return {
    id: row.group_id,
    name: row.title,
    description: row.description,
    avatarUrl: row.avatar_url,
    memberCount: Number(row.member_count),
    currentClientRole: row.role,
    members,
    upcomingBooking: upcoming
  };
}

const groupSelect = `SELECT group_record.group_id, group_record.title, group_record.description,
  group_record.avatar_url, current_member.role,
  (SELECT COUNT(*) FROM client_group_members counted_member WHERE counted_member.group_id = group_record.group_id) AS member_count
FROM client_groups group_record
INNER JOIN client_group_members current_member
  ON current_member.group_id = group_record.group_id AND current_member.client_id = $1
WHERE group_record.deleted_at IS NULL`;

export async function listClientGroups(clientId: string): Promise<ClientGroup[]> {
  const result = await pool.query<GroupRow>(`${groupSelect} ORDER BY group_record.title ASC`, [clientId]);
  return Promise.all(result.rows.map((row) => mapGroup(row, clientId)));
}

export async function getClientGroup(clientId: string, groupId: string): Promise<ClientGroup | null> {
  const result = await pool.query<GroupRow>(`${groupSelect} AND group_record.group_id = $2 LIMIT 1`, [clientId, groupId]);
  return result.rowCount ? mapGroup(result.rows[0], clientId) : null;
}

function slugFor(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

export async function createClientGroup(clientId: string, name: string, description: string): Promise<ClientGroup> {
  const groupId = await withTransaction(async (client) => {
    const inserted = await client.query<{ group_id: string }>(
      `INSERT INTO client_groups (title, description, slug, created_by_client_id)
       VALUES ($1, $2, $3, $4) RETURNING group_id`,
      [name.trim(), description.trim(), slugFor(name), clientId]
    );
    await client.query(
      `INSERT INTO client_group_members (group_id, client_id, role) VALUES ($1, $2, 'owner')`,
      [inserted.rows[0].group_id, clientId]
    );
    return inserted.rows[0].group_id;
  });
  const group = await getClientGroup(clientId, groupId);
  if (!group) throw new Error('Failed to load the created group.');
  return group;
}

export async function updateClientGroup(
  clientId: string,
  groupId: string,
  input: { name?: string; description?: string }
): Promise<ClientGroup | null | 'forbidden'> {
  const result = await pool.query(
    `UPDATE client_groups group_record SET
       title = COALESCE($3, group_record.title),
       description = COALESCE($4, group_record.description),
       updated_at = NOW()
     FROM client_group_members member
     WHERE group_record.group_id = $2
       AND member.group_id = group_record.group_id
       AND member.client_id = $1
       AND member.role IN ('owner', 'admin')`,
    [clientId, groupId, input.name, input.description]
  );
  if (!result.rowCount) return (await getClientGroup(clientId, groupId)) ? 'forbidden' : null;
  return getClientGroup(clientId, groupId);
}

export async function deleteClientGroup(clientId: string, groupId: string): Promise<boolean | 'forbidden'> {
  const result = await pool.query(
    `UPDATE client_groups group_record SET deleted_at = NOW(), updated_at = NOW()
     FROM client_group_members member
     WHERE group_record.group_id = $2 AND member.group_id = group_record.group_id
       AND member.client_id = $1 AND member.role = 'owner'`,
    [clientId, groupId]
  );
  if (result.rowCount) return true;
  return (await getClientGroup(clientId, groupId)) ? 'forbidden' : false;
}

export async function createClientGroupInvite(clientId: string, groupId: string, email?: string) {
  const membership = await pool.query<{ role: string }>(
    `SELECT role FROM client_group_members WHERE group_id = $1 AND client_id = $2 LIMIT 1`,
    [groupId, clientId]
  );
  if (!membership.rowCount || !['owner', 'admin'].includes(membership.rows[0].role)) return null;
  const token = randomBytes(32).toString('base64url');
  const result = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO client_group_invites (group_id, invited_by_client_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
     RETURNING id, expires_at`,
    [groupId, clientId, email?.trim().toLowerCase() || null, hashClientToken(token)]
  );
  return {
    id: result.rows[0].id,
    groupId,
    token,
    email: email?.trim().toLowerCase() || null,
    expiresAt: result.rows[0].expires_at,
    status: 'pending' as const
  };
}

export async function joinClientGroup(clientId: string, token: string): Promise<string | null> {
  return withTransaction(async (client) => {
    const invite = await client.query<{ id: string; group_id: string; email: string | null }>(
      `SELECT id, group_id, email
       FROM client_group_invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       LIMIT 1 FOR UPDATE`,
      [hashClientToken(token)]
    );
    if (!invite.rowCount) return null;
    const row = invite.rows[0];
    if (row.email) {
      const profile = await client.query<{ email: string }>(`SELECT email::text AS email FROM clients WHERE client_id = $1`, [clientId]);
      if (!profile.rowCount || profile.rows[0].email.toLowerCase() !== row.email.toLowerCase()) return null;
    }
    await client.query(
      `INSERT INTO client_group_members (group_id, client_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT (group_id, client_id) DO NOTHING`,
      [row.group_id, clientId]
    );
    await client.query(`UPDATE client_group_invites SET accepted_at = NOW() WHERE id = $1`, [row.id]);
    return row.group_id;
  });
}

export async function listClientNotifications(clientId: string, cursor?: string) {
  const result = await pool.query<{
    id: string; type: string; title: string; body: string; created_at: string; read_at: string | null; deep_link: string | null;
  }>(
    `SELECT id, type, title, body, created_at, read_at, deep_link
     FROM client_notifications notification
     WHERE client_id = $1
       AND ($2::uuid IS NULL OR (notification.created_at, notification.id) < (
         SELECT cursor_notification.created_at, cursor_notification.id
         FROM client_notifications cursor_notification
         WHERE cursor_notification.id = $2 AND cursor_notification.client_id = $1
       ))
     ORDER BY created_at DESC, id DESC
     LIMIT 51`,
    [clientId, cursor ?? null]
  );
  const hasMore = result.rows.length > 50;
  const rows = result.rows.slice(0, 50);
  const allowedTypes = new Set([
    'booking_confirmation', 'booking_change', 'cancellation', 'booking_reminder',
    'access_ready', 'access_expiring', 'group_invitation', 'group_change', 'payment_issue', 'system'
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      type: allowedTypes.has(row.type) ? row.type : 'system',
      title: row.title,
      message: row.body,
      createdAt: row.created_at,
      readAt: row.read_at,
      deepLink: row.deep_link
    })),
    nextCursor: hasMore ? rows.at(-1)?.id ?? null : null
  };
}

export async function markClientNotificationRead(clientId: string, notificationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE client_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND client_id = $2`,
    [notificationId, clientId]
  );
  return Boolean(result.rowCount);
}
