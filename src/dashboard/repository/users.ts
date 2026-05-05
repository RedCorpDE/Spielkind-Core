import { pool } from '../../db/client.js';
import type { DashboardUser } from '../types.js';

export async function listUsers(): Promise<DashboardUser[]> {
  const result = await pool.query<{ id: string; email: string; display_name: string; role: string }>(
    `SELECT id, email, display_name, role
     FROM users
     WHERE is_active = true AND can_access_dashboard = true
     ORDER BY display_name ASC`
  );

  return result.rows.map((row) => ({ id: row.id, email: row.email, name: row.display_name, role: row.role }));
}

export async function updateUserRole(userId: string, role: string): Promise<{ id: string; email: string; display_name: string; role: string }> {
  const result = await pool.query<{ id: string; email: string; display_name: string; role: string }>(
    `UPDATE users
     SET role = $1
     WHERE id = $2 AND is_active = true
     RETURNING id, email, display_name, role`,
    [role, userId]
  );

  if (result.rowCount === 0) {
    throw new Error('User not found or not active.');
  }

  return result.rows[0];
}
