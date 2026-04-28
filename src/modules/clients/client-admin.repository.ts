import { pool } from '../../db/pool.js';

export interface AdminClientContactMethod {
  contactMethodId: string;
  channel: 'email' | 'telegram' | 'sms' | 'whatsapp';
  destination: string;
  isEnabled: boolean;
  isVerified: boolean;
  providerRef: string | null;
  rawJson: unknown;
}

export interface AdminClient {
  clientId: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
  email: string | null;
  phoneNumber: string | null;
  preferredContactType: string | null;
  subscribedToNewsletter: boolean;
  regiondoCustomerId: string | null;
  contactMethods: AdminClientContactMethod[];
}

interface ClientRow {
  client_id: string;
  first_name: string;
  last_name: string;
  birthday: string | null;
  email: string | null;
  phone_number: string | null;
  preferred_contact_type: string | null;
  subscribed_to_newsletter: boolean;
  regiondo_customer_id: string | null;
  contact_methods: AdminClientContactMethod[] | null;
}

function mapClientRow(row: ClientRow): AdminClient {
  return {
    clientId: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    birthday: row.birthday,
    email: row.email,
    phoneNumber: row.phone_number,
    preferredContactType: row.preferred_contact_type,
    subscribedToNewsletter: row.subscribed_to_newsletter,
    regiondoCustomerId: row.regiondo_customer_id,
    contactMethods: row.contact_methods ?? []
  };
}

const clientSelect = `SELECT
   c.client_id,
   c.first_name,
   c.last_name,
   c.birthday::text AS birthday,
   c.email::text AS email,
   c.phone_number,
   c.preferred_contact_type,
   c.subscribed_to_newsletter,
   c.regiondo_customer_id,
   COALESCE(
     jsonb_agg(
       DISTINCT jsonb_build_object(
         'contactMethodId', cm.contact_method_id,
         'channel', cm.channel,
         'destination', cm.destination,
         'isEnabled', cm.is_enabled,
         'isVerified', cm.is_verified,
         'providerRef', cm.provider_ref,
         'rawJson', cm.raw_json
       )
     ) FILTER (WHERE cm.contact_method_id IS NOT NULL),
     '[]'::jsonb
   ) AS contact_methods
 FROM clients c
 LEFT JOIN client_contact_methods cm ON cm.client_id = c.client_id`;

export async function listAdminClients(search?: string): Promise<AdminClient[]> {
  const result = await pool.query<ClientRow>(
    `${clientSelect}
     WHERE (
       $1::text IS NULL
       OR c.first_name ILIKE $1
       OR c.last_name ILIKE $1
       OR COALESCE(c.email::text, '') ILIKE $1
       OR COALESCE(c.phone_number, '') ILIKE $1
     )
     GROUP BY c.client_id
     ORDER BY c.last_name ASC, c.first_name ASC`,
    [search?.trim() ? `%${search.trim()}%` : null]
  );

  return result.rows.map(mapClientRow);
}

export async function getAdminClient(clientId: string): Promise<AdminClient | null> {
  const result = await pool.query<ClientRow>(
    `${clientSelect}
     WHERE c.client_id = $1
     GROUP BY c.client_id
     LIMIT 1`,
    [clientId]
  );

  return result.rowCount ? mapClientRow(result.rows[0]) : null;
}

export async function updateAdminClient(
  clientId: string,
  input: {
    firstName?: string;
    lastName?: string;
    birthday?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
    preferredContactType?: string | null;
    subscribedToNewsletter?: boolean;
    contactMethods?: Array<{
      channel: 'email' | 'telegram' | 'sms' | 'whatsapp';
      destination: string;
      isEnabled?: boolean;
      isVerified?: boolean;
      providerRef?: string | null;
      rawJson?: unknown;
    }>;
  }
): Promise<AdminClient | null> {
  const existing = await getAdminClient(clientId);
  if (!existing) {
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE clients
       SET
         first_name = $1,
         last_name = $2,
         birthday = $3::date,
         email = $4,
         phone_number = $5,
         preferred_contact_type = $6,
         subscribed_to_newsletter = $7
       WHERE client_id = $8`,
      [
        input.firstName?.trim() || existing.firstName,
        input.lastName?.trim() || existing.lastName,
        input.birthday === undefined ? existing.birthday : input.birthday,
        input.email === undefined ? existing.email : input.email,
        input.phoneNumber === undefined ? existing.phoneNumber : input.phoneNumber,
        input.preferredContactType === undefined ? existing.preferredContactType : input.preferredContactType,
        input.subscribedToNewsletter ?? existing.subscribedToNewsletter,
        clientId
      ]
    );

    if (input.contactMethods) {
      await client.query(`DELETE FROM client_contact_methods WHERE client_id = $1`, [clientId]);

      for (const method of input.contactMethods) {
        await client.query(
          `INSERT INTO client_contact_methods (
             client_id,
             channel,
             destination,
             is_enabled,
             is_verified,
             provider_ref,
             raw_json
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            clientId,
            method.channel,
            method.destination,
            method.isEnabled ?? true,
            method.isVerified ?? false,
            method.providerRef ?? null,
            JSON.stringify(method.rawJson ?? {})
          ]
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
