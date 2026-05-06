CREATE TABLE IF NOT EXISTS user_roles (
  name       citext PRIMARY KEY,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO user_roles (name, is_system)
VALUES
  ('Admin', true),
  ('Manager', false),
  ('Staff', false),
  ('Viewer', false),
ON CONFLICT (name) DO UPDATE
SET is_system = user_roles.is_system OR EXCLUDED.is_system;

INSERT INTO user_roles (name)
SELECT DISTINCT btrim(role)
FROM users
WHERE role IS NOT NULL
  AND btrim(role) <> ''
ON CONFLICT (name) DO NOTHING;

UPDATE users AS target
SET role = source.name::text
FROM user_roles AS source
WHERE lower(target.role) = lower(source.name::text)
  AND target.role <> source.name::text;

DROP TRIGGER IF EXISTS trg_user_roles_updated_at ON user_roles;
CREATE TRIGGER trg_user_roles_updated_at
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
