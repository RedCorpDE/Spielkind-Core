CREATE TABLE IF NOT EXISTS booking_change_requests (
  change_request_id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  changes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected', 'conflict', 'cancelled')),
  completed_at timestamptz,
  resolved_by text,
  resolution jsonb
);

CREATE INDEX IF NOT EXISTS idx_booking_change_requests_active
  ON booking_change_requests (booking_id, requested_at DESC)
  WHERE status IN ('pending', 'conflict');
