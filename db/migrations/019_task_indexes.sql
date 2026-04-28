CREATE INDEX IF NOT EXISTS idx_tasks_column_key
  ON tasks(column_key);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_user_id
  ON tasks(assignee_user_id);

CREATE INDEX IF NOT EXISTS idx_tasks_connected_booking_key
  ON tasks(connected_booking_key);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_active_column_key
  ON tasks(column_key)
  WHERE is_deleted = false;
