CREATE TABLE IF NOT EXISTS task_kanban_columns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL UNIQUE,
  booking_related boolean NOT NULL DEFAULT false,
  position        integer NOT NULL UNIQUE CHECK (position >= 0),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
