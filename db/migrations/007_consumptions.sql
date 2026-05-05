CREATE TABLE IF NOT EXISTS consumptions (
  consumption_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  booking_id        uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  resource_id       uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,

  type              text NOT NULL DEFAULT 'reserved'
    CHECK (type IN ('reserved','consumed','blocked','maintenance')),

  dt_from           timestamptz NOT NULL,
  dt_to             timestamptz NOT NULL,
  CHECK (dt_to > dt_from),

  -- for capacity-based resources (seats, PCs, etc.)
  capacity_used     integer NOT NULL DEFAULT 1 CHECK (capacity_used > 0),

  created_at        timestamptz NOT NULL DEFAULT now()
);