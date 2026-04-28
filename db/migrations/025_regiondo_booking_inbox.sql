ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS regiondo_order_number text,
  ADD COLUMN IF NOT EXISTS regiondo_snapshot_generated_at timestamptz;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('draft', 'pending', 'processing', 'confirmed', 'completed', 'rejected', 'canceled', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_bookings_regiondo_order_number
  ON bookings(regiondo_order_number)
  WHERE regiondo_order_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_regiondo_snapshot_generated_at
  ON bookings(regiondo_snapshot_generated_at DESC)
  WHERE regiondo_snapshot_generated_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_admin_metadata (
  booking_id                uuid PRIMARY KEY REFERENCES bookings(booking_id) ON DELETE CASCADE,
  ops_status                text NOT NULL DEFAULT 'normal'
    CHECK (ops_status IN ('normal', 'escalated')),
  ops_notes                 text NOT NULL DEFAULT '',
  last_provider_edit_error  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO booking_admin_metadata (booking_id, ops_status, ops_notes)
SELECT
  booking_id,
  CASE
    WHEN dashboard_data ->> 'status' = 'Escalated' THEN 'escalated'
    ELSE 'normal'
  END,
  COALESCE(NULLIF(dashboard_data ->> 'opsNotes', ''), '')
FROM bookings
WHERE dashboard_data <> '{}'::jsonb
ON CONFLICT (booking_id) DO UPDATE
SET
  ops_status = EXCLUDED.ops_status,
  ops_notes = CASE
    WHEN booking_admin_metadata.ops_notes = '' THEN EXCLUDED.ops_notes
    ELSE booking_admin_metadata.ops_notes
  END;

DROP TRIGGER IF EXISTS trg_booking_admin_metadata_updated_at ON booking_admin_metadata;
CREATE TRIGGER trg_booking_admin_metadata_updated_at
  BEFORE UPDATE ON booking_admin_metadata
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS regiondo_webhook_events (
  event_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_key             text NOT NULL,
  order_number            text,
  action_type             text,
  channel                 text,
  dedupe_key              text NOT NULL UNIQUE,
  provider_snapshot_at    timestamptz,
  payload                 jsonb NOT NULL,
  headers                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                  text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'processed', 'dead_letter')),
  attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error              text,
  locked_at               timestamptz,
  available_at            timestamptz NOT NULL DEFAULT now(),
  processed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_regiondo_webhook_events_claim
  ON regiondo_webhook_events(status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_regiondo_webhook_events_booking_key
  ON regiondo_webhook_events(booking_key, created_at DESC);

DROP TRIGGER IF EXISTS trg_regiondo_webhook_events_updated_at ON regiondo_webhook_events;
CREATE TRIGGER trg_regiondo_webhook_events_updated_at
  BEFORE UPDATE ON regiondo_webhook_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
