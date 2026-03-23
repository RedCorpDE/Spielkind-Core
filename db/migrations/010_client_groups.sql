CREATE TABLE IF NOT EXISTS client_groups (
  group_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL UNIQUE,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
