CREATE TABLE IF NOT EXISTS locations (
  location_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  description          text,
  image_url            text,

  regiondo_location_id text UNIQUE,
  regiondo_raw         jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
