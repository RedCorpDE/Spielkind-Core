import { pool } from '../../db/pool.js';

export interface AdminClientGroupMember {
  clientId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  joinedAt: string;
}

export interface AdminClientGroup {
  groupId: string;
  title: string;
  members: AdminClientGroupMember[];
}

interface ClientGroupRow {
  group_id: string;
  title: string;
  members: AdminClientGroupMember[] | null;
}

function mapClientGroupRow(row: ClientGroupRow): AdminClientGroup {
  return {
    groupId: row.group_id,
    title: row.title,
    members: row.members ?? []
  };
}

const clientGroupSelect = `SELECT
   g.group_id,
   g.title,
   COALESCE(
     jsonb_agg(
       DISTINCT jsonb_build_object(
         'clientId', c.client_id,
         'firstName', c.first_name,
         'lastName', c.last_name,
         'email', c.email,
         'joinedAt', m.joined_at
       )
     ) FILTER (WHERE c.client_id IS NOT NULL),
     '[]'::jsonb
   ) AS members
 FROM client_groups g
 LEFT JOIN client_group_members m ON m.group_id = g.group_id
 LEFT JOIN clients c ON c.client_id = m.client_id`;

export async function listAdminClientGroups(): Promise<AdminClientGroup[]> {
  const result = await pool.query<ClientGroupRow>(
    `${clientGroupSelect}
     GROUP BY g.group_id
     ORDER BY g.title ASC`
  );

  return result.rows.map(mapClientGroupRow);
}

export async function getAdminClientGroup(groupId: string): Promise<AdminClientGroup | null> {
  const result = await pool.query<ClientGroupRow>(
    `${clientGroupSelect}
     WHERE g.group_id = $1
     GROUP BY g.group_id
     LIMIT 1`,
    [groupId]
  );

  return result.rowCount ? mapClientGroupRow(result.rows[0]) : null;
}

export async function createAdminClientGroup(title: string): Promise<AdminClientGroup> {
  const result = await pool.query<{ group_id: string }>(
    `INSERT INTO client_groups (title)
     VALUES ($1)
     RETURNING group_id`,
    [title.trim()]
  );

  const group = await getAdminClientGroup(result.rows[0].group_id);
  if (!group) {
    throw new Error('Failed to create client group.');
  }

  return group;
}

export async function updateAdminClientGroup(groupId: string, title: string): Promise<AdminClientGroup | null> {
  const result = await pool.query(
    `UPDATE client_groups
     SET title = $1
     WHERE group_id = $2`,
    [title.trim(), groupId]
  );

  if (!result.rowCount) {
    return null;
  }

  return getAdminClientGroup(groupId);
}

export async function deleteAdminClientGroup(groupId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM client_groups
     WHERE group_id = $1`,
    [groupId]
  );

  return Boolean(result.rowCount);
}

export async function attachClientGroupMember(groupId: string, clientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO client_group_members (group_id, client_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, client_id) DO NOTHING`,
    [groupId, clientId]
  );
}

export async function detachClientGroupMember(groupId: string, clientId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM client_group_members
     WHERE group_id = $1
       AND client_id = $2`,
    [groupId, clientId]
  );

  return Boolean(result.rowCount);
}
