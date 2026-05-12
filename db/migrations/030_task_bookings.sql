CREATE TABLE IF NOT EXISTS task_bookings (
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, booking_id)
);

INSERT INTO task_bookings (task_id, booking_id)
SELECT id, connected_booking_key
FROM tasks
WHERE connected_booking_key IS NOT NULL
ON CONFLICT (task_id, booking_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_task_bookings_booking_id
  ON task_bookings (booking_id);

CREATE INDEX IF NOT EXISTS idx_task_bookings_task_id
  ON task_bookings (task_id);
