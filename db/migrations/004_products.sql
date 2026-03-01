CREATE TABLE IF NOT EXISTS products (
  product_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  description         text,
  image_url           text,
  base_amount         numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),

  regiondo_product_id text UNIQUE,
  regiondo_raw        jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
