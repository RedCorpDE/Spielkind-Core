ALTER TABLE client_group_members
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE client_group_members SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE client_group_members
    ALTER COLUMN id SET NOT NULL,
    ADD CONSTRAINT client_group_members_id_unique UNIQUE (id),
    ADD CONSTRAINT client_group_members_role_check CHECK (role IN ('owner', 'admin', 'member'));

CREATE INDEX idx_client_group_members_client
    ON client_group_members(client_id);

CREATE INDEX idx_client_group_members_group_role
    ON client_group_members(group_id, role);
