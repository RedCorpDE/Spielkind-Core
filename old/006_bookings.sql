CREATE TABLE IF NOT EXISTS bookings (
  booking_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id          uuid NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
  location_id        uuid NOT NULL REFERENCES locations(location_id) ON DELETE RESTRICT,

  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('draft','pending','confirmed','checked_in','completed','cancelled','no_show')),

  guest_count        integer NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  total_amount       numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount        numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),

  dt_from            timestamptz NOT NULL,
  dt_to              timestamptz NOT NULL,
  CHECK (dt_to > dt_from),

  source             text NOT NULL DEFAULT 'regiondo'
    CHECK (source IN ('regiondo','manual','api','self-service','app')),

  regiondo_booking_id text UNIQUE,
  regiondo_raw        jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
