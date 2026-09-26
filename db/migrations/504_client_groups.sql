ALTER TABLE client_groups
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS slug TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS created_by_client_id UUID
        REFERENCES clients(client_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

UPDATE client_groups
SET slug = LOWER(REGEXP_REPLACE(TRIM(title), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || LEFT(group_id::TEXT, 8)
WHERE slug IS NULL;

ALTER TABLE client_groups
    ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX uq_client_groups_slug
    ON client_groups(slug);

CREATE INDEX idx_client_groups_created_by
    ON client_groups(created_by_client_id);

CREATE INDEX idx_client_groups_active
    ON client_groups(created_at)
    WHERE deleted_at IS NULL;
