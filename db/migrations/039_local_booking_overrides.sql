ALTER TABLE booking_admin_metadata
  ADD COLUMN IF NOT EXISTS provider_update_outcome text,
  ADD COLUMN IF NOT EXISTS provider_update_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_update_changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_update_message text,
  ADD COLUMN IF NOT EXISTS local_override_fields text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE booking_admin_metadata
  DROP CONSTRAINT IF EXISTS booking_admin_metadata_provider_update_outcome_check;

ALTER TABLE booking_admin_metadata
  ADD CONSTRAINT booking_admin_metadata_provider_update_outcome_check
  CHECK (provider_update_outcome IS NULL OR provider_update_outcome IN ('not_supported', 'succeeded', 'failed'));

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS local_override_fields text[] NOT NULL DEFAULT ARRAY[]::text[];
