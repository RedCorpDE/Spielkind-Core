ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS key text,
  ADD COLUMN IF NOT EXISTS description text;

UPDATE user_roles
SET key = CASE
  WHEN btrim(regexp_replace(lower(name::text), '[^a-z0-9]+', '_', 'g'), '_') = ''
    THEN 'role_' || substr(md5(name::text), 1, 8)
  ELSE btrim(regexp_replace(lower(name::text), '[^a-z0-9]+', '_', 'g'), '_')
END
WHERE key IS NULL
   OR btrim(key) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_key
  ON user_roles(key);

ALTER TABLE user_roles
  ALTER COLUMN key SET NOT NULL;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_key   text NOT NULL REFERENCES user_roles(key) ON DELETE CASCADE,
  resource   text NOT NULL,
  action     text NOT NULL,
  scope      text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT role_permissions_pk PRIMARY KEY (role_key, resource, action),
  CONSTRAINT role_permissions_scope_check CHECK (scope IN ('none', 'own', 'location', 'all'))
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role_key
  ON role_permissions(role_key);

DROP TRIGGER IF EXISTS trg_role_permissions_updated_at ON role_permissions;
CREATE TRIGGER trg_role_permissions_updated_at
  BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
