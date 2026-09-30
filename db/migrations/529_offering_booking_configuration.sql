-- Move booking ownership and booking rules to the location-specific offering.
-- Product-level booking_provider remains as a compatibility default while every
-- existing offering is backfilled explicitly. Historical bookings keep their
-- immutable bookings.booking_provider value.

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS booking_provider text,
  ADD COLUMN IF NOT EXISTS time_selection_mode text NOT NULL DEFAULT 'start_end',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Berlin',
  ADD COLUMN IF NOT EXISTS min_participants integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_participants integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS min_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS max_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS duration_step_minutes integer,
  ADD COLUMN IF NOT EXISTS default_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS allowed_duration_minutes integer[],
  ADD COLUMN IF NOT EXISTS min_advance_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_advance_days integer,
  ADD COLUMN IF NOT EXISTS same_day_booking_allowed boolean NOT NULL DEFAULT true;

UPDATE location_products offering
SET booking_provider = product.booking_provider
FROM products product
WHERE product.product_id = offering.product_id
  AND offering.booking_provider IS NULL;

ALTER TABLE location_products
  ALTER COLUMN booking_provider SET DEFAULT 'core',
  ALTER COLUMN booking_provider SET NOT NULL;

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_booking_provider_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_booking_provider_check
  CHECK (booking_provider IN ('core', 'regiondo'));
ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_time_selection_mode_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_time_selection_mode_check
  CHECK (time_selection_mode IN ('date_range', 'start_end', 'start_duration', 'fixed_duration'));
ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_participant_limits_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_participant_limits_check
  CHECK (min_participants > 0 AND max_participants >= min_participants);
ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_duration_limits_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_duration_limits_check
  CHECK (
    (min_duration_minutes IS NULL OR min_duration_minutes > 0)
    AND (max_duration_minutes IS NULL OR max_duration_minutes > 0)
    AND (min_duration_minutes IS NULL OR max_duration_minutes IS NULL OR max_duration_minutes >= min_duration_minutes)
    AND (duration_step_minutes IS NULL OR duration_step_minutes > 0)
    AND (default_duration_minutes IS NULL OR default_duration_minutes > 0)
  );
ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_advance_limits_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_advance_limits_check
  CHECK (min_advance_minutes >= 0 AND (max_advance_days IS NULL OR max_advance_days >= 0));

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_duration_minutes_check;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_duration_minutes_check
  CHECK (duration_minutes IS NULL OR duration_minutes > 0);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS product_offering_id uuid REFERENCES location_products(product_offering_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_bookings_product_offering_id ON bookings(product_offering_id);

ALTER TABLE booking_items
  ADD COLUMN IF NOT EXISTS product_offering_id uuid REFERENCES location_products(product_offering_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_booking_items_product_offering_id ON booking_items(product_offering_id);

ALTER TABLE reservation_holds
  ADD COLUMN IF NOT EXISTS product_offering_id uuid REFERENCES location_products(product_offering_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_reservation_holds_product_offering_id ON reservation_holds(product_offering_id);

ALTER TABLE provider_references DROP CONSTRAINT IF EXISTS provider_references_entity_type_check;
ALTER TABLE provider_references ADD CONSTRAINT provider_references_entity_type_check
  CHECK (entity_type IN ('booking', 'location', 'product', 'product_offering', 'product_variant', 'payment', 'refund'));

INSERT INTO provider_references (provider, entity_type, entity_id, external_id, metadata)
SELECT DISTINCT ON (product.product_id)
  'regiondo', 'product_offering', offering.product_offering_id, product.regiondo_product_id,
  jsonb_build_object('backfilledFrom', 'product')
FROM location_products offering
INNER JOIN products product ON product.product_id = offering.product_id
WHERE offering.booking_provider = 'regiondo'
  AND product.regiondo_product_id IS NOT NULL
ORDER BY product.product_id, offering.created_at, offering.product_offering_id
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN location_products.booking_provider IS
  'Provider used for new bookings of this offering. Existing bookings retain bookings.booking_provider.';
COMMENT ON COLUMN bookings.product_offering_id IS
  'Immutable offering selected when the booking was created; nullable for historical imports.';
