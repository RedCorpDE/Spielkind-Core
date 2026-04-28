import { pool } from '../../db/pool.js';

type ReminderChannel = 'email' | 'telegram' | 'sms' | 'whatsapp';
type ReminderDeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';

export interface AdminReminderRule {
  reminderRuleId: string;
  title: string;
  isEnabled: boolean;
  triggerType: string;
  offsetMinutes: number;
  additionalChannels: ReminderChannel[];
  reminderType: string;
  messageTemplate: string;
  locationId: string | null;
  productId: string | null;
  bookingStatuses: string[];
  createdByUserId: string | null;
}

export interface AdminReminderDelivery {
  reminderDeliveryId: string;
  reminderRuleId: string;
  ruleTitle: string;
  bookingId: string;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  locationTitle: string | null;
  bookingStartsAt: string | null;
  channel: ReminderChannel;
  reminderType: string;
  scheduledFor: string;
  status: ReminderDeliveryStatus;
  dedupeKey: string;
  attemptCount: number;
  lastError: string | null;
  sentAt: string | null;
}

interface ReminderRuleRow {
  reminder_rule_id: string;
  title: string;
  is_enabled: boolean;
  trigger_type: string;
  offset_minutes: number;
  additional_channels: ReminderChannel[];
  reminder_type: string;
  message_template: string;
  location_id: string | null;
  product_id: string | null;
  booking_statuses: string[];
  created_by_user_id: string | null;
}

interface ReminderDeliveryRow {
  reminder_delivery_id: string;
  reminder_rule_id: string;
  rule_title: string;
  booking_id: string;
  client_id: string;
  client_name: string;
  client_email: string | null;
  location_title: string | null;
  booking_starts_at: string | null;
  channel: ReminderChannel;
  reminder_type: string;
  scheduled_for: string;
  status: ReminderDeliveryStatus;
  dedupe_key: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
}

function mapReminderRuleRow(row: ReminderRuleRow): AdminReminderRule {
  return {
    reminderRuleId: row.reminder_rule_id,
    title: row.title,
    isEnabled: row.is_enabled,
    triggerType: row.trigger_type,
    offsetMinutes: row.offset_minutes,
    additionalChannels: row.additional_channels ?? [],
    reminderType: row.reminder_type,
    messageTemplate: row.message_template,
    locationId: row.location_id,
    productId: row.product_id,
    bookingStatuses: row.booking_statuses ?? [],
    createdByUserId: row.created_by_user_id
  };
}

function mapReminderDeliveryRow(row: ReminderDeliveryRow): AdminReminderDelivery {
  return {
    reminderDeliveryId: row.reminder_delivery_id,
    reminderRuleId: row.reminder_rule_id,
    ruleTitle: row.rule_title,
    bookingId: row.booking_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientEmail: row.client_email,
    locationTitle: row.location_title,
    bookingStartsAt: row.booking_starts_at,
    channel: row.channel,
    reminderType: row.reminder_type,
    scheduledFor: row.scheduled_for,
    status: row.status,
    dedupeKey: row.dedupe_key,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    sentAt: row.sent_at
  };
}

export async function listReminderRules(): Promise<AdminReminderRule[]> {
  const result = await pool.query<ReminderRuleRow>(
    `SELECT
       reminder_rule_id,
       title,
       is_enabled,
       trigger_type,
       offset_minutes,
       additional_channels,
       reminder_type,
       message_template,
       location_id,
       product_id,
       booking_statuses,
       created_by_user_id
     FROM reminder_rules
     ORDER BY title ASC`
  );

  return result.rows.map(mapReminderRuleRow);
}

export async function getReminderRule(reminderRuleId: string): Promise<AdminReminderRule | null> {
  const result = await pool.query<ReminderRuleRow>(
    `SELECT
       reminder_rule_id,
       title,
       is_enabled,
       trigger_type,
       offset_minutes,
       additional_channels,
       reminder_type,
       message_template,
       location_id,
       product_id,
       booking_statuses,
       created_by_user_id
     FROM reminder_rules
     WHERE reminder_rule_id = $1
     LIMIT 1`,
    [reminderRuleId]
  );

  return result.rowCount ? mapReminderRuleRow(result.rows[0]) : null;
}

export async function createReminderRule(input: {
  title: string;
  isEnabled: boolean;
  triggerType: string;
  offsetMinutes: number;
  additionalChannels: ReminderChannel[];
  reminderType: string;
  messageTemplate: string;
  locationId?: string | null;
  productId?: string | null;
  bookingStatuses: string[];
  createdByUserId?: string | null;
}): Promise<AdminReminderRule> {
  const result = await pool.query<{ reminder_rule_id: string }>(
    `INSERT INTO reminder_rules (
       title,
       is_enabled,
       trigger_type,
       offset_minutes,
       additional_channels,
       reminder_type,
       message_template,
       location_id,
       product_id,
       booking_statuses,
       created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING reminder_rule_id`,
    [
      input.title.trim(),
      input.isEnabled,
      input.triggerType,
      input.offsetMinutes,
      input.additionalChannels,
      input.reminderType,
      input.messageTemplate,
      input.locationId ?? null,
      input.productId ?? null,
      input.bookingStatuses,
      input.createdByUserId ?? null
    ]
  );

  const created = await getReminderRule(result.rows[0].reminder_rule_id);
  if (!created) {
    throw new Error('Failed to create reminder rule.');
  }

  return created;
}

export async function updateReminderRule(
  reminderRuleId: string,
  input: Partial<{
    title: string;
    isEnabled: boolean;
    triggerType: string;
    offsetMinutes: number;
    additionalChannels: ReminderChannel[];
    reminderType: string;
    messageTemplate: string;
    locationId: string | null;
    productId: string | null;
    bookingStatuses: string[];
  }>
): Promise<AdminReminderRule | null> {
  const existing = await getReminderRule(reminderRuleId);
  if (!existing) {
    return null;
  }

  await pool.query(
    `UPDATE reminder_rules
     SET
       title = $1,
       is_enabled = $2,
       trigger_type = $3,
       offset_minutes = $4,
       additional_channels = $5,
       reminder_type = $6,
       message_template = $7,
       location_id = $8,
       product_id = $9,
       booking_statuses = $10
     WHERE reminder_rule_id = $11`,
    [
      input.title?.trim() || existing.title,
      input.isEnabled ?? existing.isEnabled,
      input.triggerType ?? existing.triggerType,
      input.offsetMinutes ?? existing.offsetMinutes,
      input.additionalChannels ?? existing.additionalChannels,
      input.reminderType ?? existing.reminderType,
      input.messageTemplate ?? existing.messageTemplate,
      input.locationId === undefined ? existing.locationId : input.locationId,
      input.productId === undefined ? existing.productId : input.productId,
      input.bookingStatuses ?? existing.bookingStatuses,
      reminderRuleId
    ]
  );

  return getReminderRule(reminderRuleId);
}

export async function deleteReminderRule(reminderRuleId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM reminder_rules
     WHERE reminder_rule_id = $1`,
    [reminderRuleId]
  );

  return Boolean(result.rowCount);
}

export async function listReminderDeliveries(filters: {
  status?: ReminderDeliveryStatus;
  bookingId?: string;
  limit?: number;
} = {}): Promise<AdminReminderDelivery[]> {
  const result = await pool.query<ReminderDeliveryRow>(
    `SELECT
       rd.reminder_delivery_id,
       rd.reminder_rule_id,
       rr.title AS rule_title,
       rd.booking_id,
       rd.client_id,
       TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS client_name,
       c.email AS client_email,
       l.title AS location_title,
       b.dt_from::text AS booking_starts_at,
       rd.channel,
       rd.reminder_type,
       rd.scheduled_for::text,
       rd.status,
       rd.dedupe_key,
       rd.attempt_count,
       rd.last_error,
       rd.sent_at::text
     FROM reminder_deliveries rd
     INNER JOIN reminder_rules rr ON rr.reminder_rule_id = rd.reminder_rule_id
     INNER JOIN clients c ON c.client_id = rd.client_id
     LEFT JOIN bookings b ON b.booking_id = rd.booking_id
     LEFT JOIN locations l ON l.location_id = b.location_id
     WHERE ($1::text IS NULL OR rd.status = $1::text)
       AND ($2::uuid IS NULL OR rd.booking_id = $2::uuid)
     ORDER BY rd.scheduled_for DESC, rd.created_at DESC
     LIMIT $3`,
    [filters.status ?? null, filters.bookingId ?? null, filters.limit ?? 100]
  );

  return result.rows.map(mapReminderDeliveryRow);
}

export async function retryReminderDelivery(reminderDeliveryId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE reminder_deliveries
     SET
       status = 'pending',
       scheduled_for = now(),
       locked_at = null,
       last_error = null,
       provider_response = NULL,
       sent_at = NULL
     WHERE reminder_delivery_id = $1
       AND status IN ('failed', 'skipped')`,
    [reminderDeliveryId]
  );

  return Boolean(result.rowCount);
}
