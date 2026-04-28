ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dashboard_data jsonb NOT NULL DEFAULT '{}'::jsonb;
