CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  role         text NOT NULL DEFAULT 'user',
  is_active    boolean NOT NULL DEFAULT true,
  can_access_dashboard boolean NOT NULL DEFAULT false,
  password_hash text,
  last_login_at timestamptz,
  raw_json     jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
