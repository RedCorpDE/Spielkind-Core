-- Core Product Offering resource requirements can consume capacity either per
-- participant/quantity or once per booking. Existing rows retain the legacy
-- per-quantity behavior.
ALTER TABLE product_offering_resources
  ADD COLUMN IF NOT EXISTS scaling_mode text NOT NULL DEFAULT 'per_quantity';

ALTER TABLE product_offering_resources
  DROP CONSTRAINT IF EXISTS product_offering_resources_scaling_mode_check;
ALTER TABLE product_offering_resources
  ADD CONSTRAINT product_offering_resources_scaling_mode_check
  CHECK (scaling_mode IN ('per_quantity', 'per_booking'));

COMMENT ON COLUMN product_offering_resources.scaling_mode IS
  'Core capacity scaling: per_quantity multiplies by participant quantity; per_booking consumes the requirement once.';
