-- Core-native customer-selectable start-slot configuration.
-- Regiondo offerings remain provider-driven and do not consume these fields.

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS earliest_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS latest_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS start_interval_minutes integer NOT NULL DEFAULT 30;

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_start_interval_minutes_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_start_interval_minutes_check
  CHECK (start_interval_minutes BETWEEN 1 AND 1440);

COMMENT ON COLUMN location_products.earliest_start_time IS
  'Optional earliest customer-selectable venue-local start time for Core offerings.';
COMMENT ON COLUMN location_products.latest_start_time IS
  'Optional latest customer-selectable venue-local start time for Core offerings.';
COMMENT ON COLUMN location_products.start_interval_minutes IS
  'Independent interval between generated Core booking starts.';
