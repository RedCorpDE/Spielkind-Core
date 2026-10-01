-- Core-native pricing and Variant schedule eligibility. Regiondo rows retain
-- provider-controlled behavior; the defaults preserve existing Core pricing.

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'per_quantity',
  ADD COLUMN IF NOT EXISTS date_range_billing_unit text NOT NULL DEFAULT 'nights';

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_pricing_mode_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_pricing_mode_check
  CHECK (pricing_mode IN ('once', 'per_quantity', 'per_date_unit', 'per_date_unit_per_quantity'));
ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_date_range_billing_unit_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_date_range_billing_unit_check
  CHECK (date_range_billing_unit IN ('nights', 'calendar_days'));

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS schedule_rule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_weekdays smallint[],
  ADD COLUMN IF NOT EXISTS local_start_time time without time zone,
  ADD COLUMN IF NOT EXISTS local_end_time time without time zone;

ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_allowed_weekdays_check;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_allowed_weekdays_check
  CHECK (
    allowed_weekdays IS NULL OR (
      cardinality(allowed_weekdays) > 0
      AND allowed_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
    )
  );
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_schedule_window_check;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_schedule_window_check
  CHECK (
    (local_start_time IS NULL AND local_end_time IS NULL)
    OR (local_start_time IS NOT NULL AND local_end_time IS NOT NULL)
  );

COMMENT ON COLUMN location_products.pricing_mode IS
  'Core-native base-rate scaling. Regiondo pricing remains provider-controlled.';
COMMENT ON COLUMN location_products.date_range_billing_unit IS
  'Local-calendar unit used by Core date-range pricing; nights excludes departure, calendar_days is inclusive.';
COMMENT ON COLUMN product_variants.allowed_weekdays IS
  'ISO weekdays (Monday=1 through Sunday=7) used for Core Variant eligibility.';
COMMENT ON COLUMN product_variants.local_start_time IS
  'Optional inclusive booking-start window in the Product Offering timezone; may cross midnight.';
COMMENT ON COLUMN product_variants.local_end_time IS
  'Optional exclusive booking-start window end in the Product Offering timezone; may cross midnight.';
