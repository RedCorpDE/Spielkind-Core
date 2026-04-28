CREATE TABLE IF NOT EXISTS tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  column_key            uuid NOT NULL REFERENCES task_kanban_columns(id) ON DELETE RESTRICT,
  is_deleted            boolean NOT NULL DEFAULT false,
  title                 text NOT NULL,
  description           text,
  status                text NOT NULL DEFAULT 'open',
  assignee_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  update_log            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(update_log) = 'array'),
  raw_json              jsonb,
  connected_booking_key uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
