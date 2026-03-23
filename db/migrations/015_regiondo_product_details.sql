CREATE TABLE IF NOT EXISTS product_variants (
  variant_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regiondo_variant_id text NOT NULL UNIQUE,
  regiondo_product_id text NOT NULL,
  title               text,
  price               numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  regiondo_raw        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_variants_product
    FOREIGN KEY (regiondo_product_id)
    REFERENCES products(regiondo_product_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_options (
  option_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regiondo_option_id  text NOT NULL UNIQUE,
  regiondo_product_id text NOT NULL,
  title               text,
  values_json         jsonb,
  regiondo_raw        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_options_product
    FOREIGN KEY (regiondo_product_id)
    REFERENCES products(regiondo_product_id)
    ON DELETE CASCADE
);
