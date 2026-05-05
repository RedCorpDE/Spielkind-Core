ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS appointment_type text,
  ADD COLUMN IF NOT EXISTS date_from date,
  ADD COLUMN IF NOT EXISTS date_to date;

ALTER TABLE product_options
  ADD COLUMN IF NOT EXISTS regiondo_variant_id text;

ALTER TABLE product_options
  DROP CONSTRAINT IF EXISTS product_options_regiondo_option_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_options_regiondo_product_variant_option_key'
  ) THEN
    ALTER TABLE product_options
      ADD CONSTRAINT product_options_regiondo_product_variant_option_key
      UNIQUE (regiondo_product_id, regiondo_variant_id, regiondo_option_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_product_options_variant'
  ) THEN
    ALTER TABLE product_options
      ADD CONSTRAINT fk_product_options_variant
      FOREIGN KEY (regiondo_variant_id)
      REFERENCES product_variants(regiondo_variant_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_product_variants_regiondo_product
  ON product_variants(regiondo_product_id);

CREATE INDEX IF NOT EXISTS idx_product_options_regiondo_product_variant
  ON product_options(regiondo_product_id, regiondo_variant_id);
