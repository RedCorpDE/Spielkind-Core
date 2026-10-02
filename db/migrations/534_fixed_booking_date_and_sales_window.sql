-- Fixed venue-local booking dates and independent sales windows for Core offerings.
-- Regiondo offerings remain provider-driven and leave these values unused.

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS date_selection text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS fixed_date date,
  ADD COLUMN IF NOT EXISTS sales_open_at timestamptz,
  ADD COLUMN IF NOT EXISTS sales_close_at timestamptz;

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_date_selection_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_date_selection_check
  CHECK (date_selection IN ('customer', 'fixed'));

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_fixed_date_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_fixed_date_check
  CHECK (
    (date_selection = 'customer' AND fixed_date IS NULL)
    OR (date_selection = 'fixed' AND fixed_date IS NOT NULL)
  );

ALTER TABLE location_products DROP CONSTRAINT IF EXISTS location_products_sales_window_check;
ALTER TABLE location_products ADD CONSTRAINT location_products_sales_window_check
  CHECK (sales_open_at IS NULL OR sales_close_at IS NULL OR sales_close_at >= sales_open_at);

COMMENT ON COLUMN location_products.date_selection IS
  'Whether a Core offering uses a customer-selected booking date or one fixed venue-local date.';
COMMENT ON COLUMN location_products.fixed_date IS
  'Venue-local YYYY-MM-DD booking date used authoritatively when date_selection is fixed.';
COMMENT ON COLUMN location_products.sales_open_at IS
  'Optional instant from which checkout is allowed; independent from the booking schedule.';
COMMENT ON COLUMN location_products.sales_close_at IS
  'Optional instant through which checkout is allowed; independent from the booking schedule.';
