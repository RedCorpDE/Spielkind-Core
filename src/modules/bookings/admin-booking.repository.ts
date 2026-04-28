import { pool } from '../../db/pool.js';

export async function cancelBookingLocally(bookingId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE bookings
     SET status = 'canceled', updated_at = now()
     WHERE booking_id = $1`,
    [bookingId]
  );

  return Boolean(result.rowCount);
}
