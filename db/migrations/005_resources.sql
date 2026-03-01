CREATE TABLE IF NOT EXISTS resources (
  resource_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES locations(location_id) ON DELETE RESTRICT,

  type                   text NOT NULL
    CHECK (type IN ('pc-room','bed-room','console-room','beverages','other')),
  capacity_available     integer NOT NULL CHECK (capacity_available >= 0),
  title                  text NOT NULL,
  description            text,
  image_url              text,
  independently_bookable boolean NOT NULL DEFAULT false,
  base_amount            numeric(12,2) NOT NULL DEFAULT 0,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
