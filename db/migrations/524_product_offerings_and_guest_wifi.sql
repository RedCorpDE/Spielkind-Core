ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS guest_wifi jsonb;

ALTER TABLE location_products
  ADD COLUMN IF NOT EXISTS product_offering_id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE location_products
SET product_offering_id = gen_random_uuid()
WHERE product_offering_id IS NULL;

ALTER TABLE location_products
  ALTER COLUMN product_offering_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS location_products_offering_id_key
  ON location_products (product_offering_id);

CREATE INDEX IF NOT EXISTS location_products_product_id_idx
  ON location_products (product_id);

COMMENT ON TABLE location_products IS
  'Product offerings: the commercial relationship between a canonical product and a location.';

COMMENT ON COLUMN location_products.product_offering_id IS
  'Stable offering identity for future location-specific pricing, availability, provider and metadata overrides.';
