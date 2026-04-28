import { pool } from '../../db/pool.js';
import {
  buildReminderTemplateVariables,
  renderReminderTemplate
} from './reminder-template.js';

type ReminderChannel = 'email' | 'telegram' | 'sms' | 'whatsapp';

interface ReminderCandidateRow {
  reminder_rule_id: string;
  additional_channels: ReminderChannel[];
  reminder_type: string;
  booking_id: string;
  client_id: string;
  dt_from: string;
  email: string | null;
  phone_number: string | null;
  preferred_contact_type: string | null;
  scheduled_for: string;
}

interface ContactMethodRow {
  client_id: string;
  channel: ReminderChannel;
  destination: string;
  is_enabled: boolean;
  is_verified: boolean;
}

interface ReminderDeliveryRow {
  reminder_delivery_id: string;
  channel: ReminderChannel;
}

export function buildReminderDeliveryDedupeKey(
  bookingId: string,
  reminderRuleId: string,
  channel: ReminderChannel
): string {
  return `booking:${bookingId}:rule:${reminderRuleId}:${channel}`;
}

export async function createDueReminderDeliveries(limit = 250): Promise<number> {
  const candidatesResult = await pool.query<ReminderCandidateRow>(
    `SELECT
       rr.reminder_rule_id,
       rr.additional_channels,
       rr.reminder_type,
       b.booking_id,
       b.client_id,
       b.dt_from,
       c.email,
       c.phone_number,
       c.preferred_contact_type,
       (b.dt_from - (rr.offset_minutes || ' minutes')::interval) AS scheduled_for
     FROM reminder_rules rr
     INNER JOIN bookings b
       ON b.status = ANY(rr.booking_statuses)
      AND (b.dt_from - (rr.offset_minutes || ' minutes')::interval) <= now()
      AND b.dt_from >= now() - interval '30 days'
      AND (rr.location_id IS NULL OR rr.location_id = b.location_id)
      AND (
        rr.product_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM booking_products bp
          WHERE bp.booking_id = b.booking_id
            AND bp.product_id = rr.product_id
        )
      )
     INNER JOIN clients c ON c.client_id = b.client_id
     WHERE rr.is_enabled = true
     ORDER BY scheduled_for ASC
     LIMIT $1`,
    [limit]
  );

  if (!candidatesResult.rowCount) {
    return 0;
  }

  const clientIds = Array.from(new Set(candidatesResult.rows.map((row) => row.client_id)));
  const contactMethodsResult = await pool.query<ContactMethodRow>(
    `SELECT client_id, channel, destination, is_enabled, is_verified
     FROM client_contact_methods
     WHERE client_id = ANY($1::uuid[])`,
    [clientIds]
  );

  const contactMethodsByClient = new Map<string, ContactMethodRow[]>();
  for (const row of contactMethodsResult.rows) {
    const existing = contactMethodsByClient.get(row.client_id) ?? [];
    existing.push(row);
    contactMethodsByClient.set(row.client_id, existing);
  }

  let insertedCount = 0;

  for (const candidate of candidatesResult.rows) {
    const contactMethods = contactMethodsByClient.get(candidate.client_id) ?? [];
    const channels = new Set<ReminderChannel>();

    if (candidate.email) {
      channels.add('email');
    }

    for (const extraChannel of candidate.additional_channels ?? []) {
      const matchingContactMethod = contactMethods.find(
        (method) => method.channel === extraChannel && method.is_enabled && method.is_verified
      );

      if (matchingContactMethod) {
        channels.add(extraChannel);
        continue;
      }

      if (
        candidate.preferred_contact_type === extraChannel &&
        ((extraChannel === 'email' && candidate.email) ||
          ((extraChannel === 'sms' || extraChannel === 'whatsapp' || extraChannel === 'telegram') && candidate.phone_number))
      ) {
        channels.add(extraChannel);
      }
    }

    for (const channel of channels) {
      const dedupeKey = buildReminderDeliveryDedupeKey(candidate.booking_id, candidate.reminder_rule_id, channel);
      const result = await pool.query(
        `INSERT INTO reminder_deliveries (
           reminder_rule_id,
           booking_id,
           client_id,
           channel,
           reminder_type,
           scheduled_for,
           dedupe_key
         )
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          candidate.reminder_rule_id,
          candidate.booking_id,
          candidate.client_id,
          channel,
          candidate.reminder_type,
          candidate.scheduled_for,
          dedupeKey
        ]
      );

      insertedCount += result.rowCount ?? 0;
    }
  }

  return insertedCount;
}

export async function claimReminderDeliveries(limit: number): Promise<ReminderDeliveryRow[]> {
  const result = await pool.query<ReminderDeliveryRow>(
    `WITH next_deliveries AS (
       SELECT reminder_delivery_id
       FROM reminder_deliveries
       WHERE status = 'pending'
         AND scheduled_for <= now()
       ORDER BY scheduled_for ASC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE reminder_deliveries AS deliveries
     SET status = 'processing',
         locked_at = now(),
         attempt_count = deliveries.attempt_count + 1
     FROM next_deliveries
     WHERE deliveries.reminder_delivery_id = next_deliveries.reminder_delivery_id
     RETURNING deliveries.reminder_delivery_id, deliveries.channel`,
    [limit]
  );

  return result.rows;
}

export async function getReminderDeliveryPayload(reminderDeliveryId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{
    rule_title: string;
    message_template: string;
    reminder_type: string;
    channel: ReminderChannel;
    dedupe_key: string;
    booking_id: string;
    regiondo_booking_id: string | null;
    regiondo_order_number: string | null;
    booking_status: string;
    dt_from: string;
    dt_to: string;
    guest_count: number;
    total_amount: string | number;
    paid_amount: string | number;
    client_id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone_number: string | null;
    location_id: string;
    location_title: string;
    scheduled_for: string;
    products: Array<Record<string, unknown>> | null;
    resources: Array<Record<string, unknown>> | null;
  }>(
    `SELECT
       rr.title AS rule_title,
       rr.message_template,
       rd.reminder_type,
       rd.channel,
       rd.dedupe_key,
       b.booking_id,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       b.status AS booking_status,
       b.dt_from,
       b.dt_to,
       b.guest_count,
       b.total_amount,
       b.paid_amount,
       c.client_id,
       c.first_name,
       c.last_name,
       c.email,
       c.phone_number,
       l.location_id,
       l.title AS location_title,
       rd.scheduled_for,
       COALESCE(
         jsonb_agg(
           DISTINCT jsonb_build_object(
             'product_id', p.product_id,
             'title', p.title,
             'quantity', bp.quantity,
             'unit_price', bp.unit_price
           )
         ) FILTER (WHERE p.product_id IS NOT NULL),
         '[]'::jsonb
       ) AS products,
       COALESCE(
         jsonb_agg(
           DISTINCT jsonb_build_object(
             'resource_id', r.resource_id,
             'title', r.title,
             'capacity_available', r.capacity_available,
             'mapped_quantity', pr.quantity
           )
         ) FILTER (WHERE r.resource_id IS NOT NULL),
         '[]'::jsonb
       ) AS resources
     FROM reminder_deliveries rd
     INNER JOIN reminder_rules rr ON rr.reminder_rule_id = rd.reminder_rule_id
     INNER JOIN bookings b ON b.booking_id = rd.booking_id
     INNER JOIN clients c ON c.client_id = rd.client_id
     INNER JOIN locations l ON l.location_id = b.location_id
     LEFT JOIN booking_products bp ON bp.booking_id = b.booking_id
     LEFT JOIN products p ON p.product_id = bp.product_id
     LEFT JOIN product_resources pr ON pr.product_id = p.product_id
     LEFT JOIN resources r ON r.resource_id = pr.resource_id
     WHERE rd.reminder_delivery_id = $1
     GROUP BY
       rr.title,
       rr.message_template,
       rd.reminder_type,
       rd.channel,
       rd.dedupe_key,
       b.booking_id,
       b.regiondo_booking_id,
       b.regiondo_order_number,
       b.status,
       b.dt_from,
       b.dt_to,
       b.guest_count,
       b.total_amount,
       b.paid_amount,
       c.client_id,
       c.first_name,
       c.last_name,
       c.email,
       c.phone_number,
       l.location_id,
       l.title,
       rd.scheduled_for`,
    [reminderDeliveryId]
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];
  const templateVariables = buildReminderTemplateVariables({
    bookingStatus: row.booking_status,
    dtFrom: row.dt_from,
    dtTo: row.dt_to,
    email: row.email,
    firstName: row.first_name,
    guestCount: row.guest_count,
    lastName: row.last_name,
    locationTitle: row.location_title,
    paidAmount: row.paid_amount,
    products: row.products ?? [],
    regiondoOrderNumber: row.regiondo_order_number,
    resources: row.resources ?? [],
    totalAmount: row.total_amount
  });

  return {
    event_type: 'booking_reminder',
    reminder_type: row.reminder_type,
    channel: row.channel,
    dedupe_key: row.dedupe_key,
    rule: {
      title: row.rule_title
    },
    message: {
      template: row.message_template,
      rendered: renderReminderTemplate(row.message_template, templateVariables),
      variables: templateVariables
    },
    booking: {
      booking_id: row.booking_id,
      regiondo_booking_id: row.regiondo_booking_id,
      regiondo_order_number: row.regiondo_order_number,
      status: row.booking_status,
      dt_from: row.dt_from,
      dt_to: row.dt_to,
      guest_count: row.guest_count,
      total_amount: `${row.total_amount}`,
      paid_amount: `${row.paid_amount}`
    },
    client: {
      client_id: row.client_id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone_number: row.phone_number
    },
    location: {
      location_id: row.location_id,
      title: row.location_title
    },
    products: row.products ?? [],
    resources: row.resources ?? [],
    metadata: {
      source: 'core',
      scheduled_for: row.scheduled_for
    }
  };
}

export async function markReminderDeliverySent(reminderDeliveryId: string, providerResponse: unknown): Promise<void> {
  await pool.query(
    `UPDATE reminder_deliveries
     SET status = 'sent',
         provider_response = $2::jsonb,
         sent_at = now(),
         locked_at = null,
         last_error = null
     WHERE reminder_delivery_id = $1`,
    [reminderDeliveryId, JSON.stringify(providerResponse)]
  );
}

export async function markReminderDeliveryFailed(reminderDeliveryId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE reminder_deliveries
     SET status = 'failed',
         last_error = $2,
         locked_at = null
     WHERE reminder_delivery_id = $1`,
    [reminderDeliveryId, errorMessage]
  );
}
