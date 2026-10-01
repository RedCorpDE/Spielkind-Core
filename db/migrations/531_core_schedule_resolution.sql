-- Additive scheduling controls for Core-managed offerings.
-- Regiondo offerings leave these values unused and remain provider-driven.

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS fixed_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS fixed_end_time time without time zone;

ALTER TABLE product_options
  ADD COLUMN IF NOT EXISTS duration_delta_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE product_options DROP CONSTRAINT IF EXISTS product_options_duration_delta_minutes_check;
ALTER TABLE product_options ADD CONSTRAINT product_options_duration_delta_minutes_check
  CHECK (duration_delta_minutes BETWEEN -10080 AND 10080);

COMMENT ON COLUMN location_products.fixed_start_time IS
  'Optional venue-local start clock time resolved with the offering IANA timezone for Core bookings.';
COMMENT ON COLUMN location_products.fixed_end_time IS
  'Optional venue-local end clock time resolved with the offering IANA timezone for Core bookings.';
COMMENT ON COLUMN product_options.duration_delta_minutes IS
  'Additive duration adjustment used only by Core schedule resolution; Regiondo remains provider-managed.';
