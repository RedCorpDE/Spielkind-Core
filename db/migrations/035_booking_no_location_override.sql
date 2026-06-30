INSERT INTO locations (title, description, regiondo_location_id, regiondo_raw)
VALUES ('No location', NULL, '__no_location__', '{"source":"system","kind":"no_location"}'::jsonb)
ON CONFLICT (regiondo_location_id)
DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  regiondo_raw = EXCLUDED.regiondo_raw,
  updated_at = now();

ALTER TABLE booking_admin_metadata
  ADD COLUMN IF NOT EXISTS location_override text;

ALTER TABLE booking_admin_metadata
  DROP CONSTRAINT IF EXISTS booking_admin_metadata_location_override_check;

ALTER TABLE booking_admin_metadata
  ADD CONSTRAINT booking_admin_metadata_location_override_check
  CHECK (location_override IS NULL OR location_override IN ('none'));
