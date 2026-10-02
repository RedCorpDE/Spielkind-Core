-- Sprint 1 booking stabilization: auditable state transitions, checkout recovery,
-- and additive integrity/index protection for populated databases.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'draft', 'held', 'pending', 'payment_pending', 'processing', 'confirmed',
  'change_requested', 'cancel_requested', 'cancelled', 'canceled', 'checked_in',
  'in_progress', 'completed', 'payment_failed', 'expired', 'rejected', 'unknown', 'no_show'
));

CREATE TABLE IF NOT EXISTS booking_state_events (
  booking_state_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN (
    'system', 'client', 'admin', 'stripe', 'regiondo', 'job', 'integration'
  )),
  actor_id text,
  reason text,
  source text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_booking_state_events_booking
  ON booking_state_events(booking_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS payment_state_events (
  payment_state_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN (
    'system', 'client', 'admin', 'stripe', 'regiondo', 'job', 'integration'
  )),
  actor_id text,
  reason text,
  source text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_payment_state_events_booking
  ON payment_state_events(booking_id, occurred_at DESC);

ALTER TABLE web_checkout_idempotency
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'in_progress',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE web_checkout_idempotency
SET status = CASE WHEN booking_id IS NULL THEN 'failed' ELSE 'completed' END,
    completed_at = CASE WHEN booking_id IS NULL THEN NULL ELSE COALESCE(completed_at, updated_at) END
WHERE status = 'in_progress';

ALTER TABLE web_checkout_idempotency DROP CONSTRAINT IF EXISTS web_checkout_idempotency_status_check;
ALTER TABLE web_checkout_idempotency ADD CONSTRAINT web_checkout_idempotency_status_check
  CHECK (status IN ('in_progress', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_web_checkout_idempotency_recovery
  ON web_checkout_idempotency(status, updated_at)
  WHERE status IN ('in_progress', 'failed');

CREATE INDEX IF NOT EXISTS idx_booking_checkout_sessions_expiry
  ON booking_checkout_sessions(expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservation_holds_expiry
  ON reservation_holds(expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bookings_location_schedule
  ON bookings(location_id, dt_from, dt_to)
  WHERE status NOT IN ('cancelled', 'canceled', 'rejected', 'expired');

CREATE INDEX IF NOT EXISTS idx_payments_provider_lookup
  ON payments(provider, provider_payment_id, provider_checkout_id);

-- NOT VALID preserves legacy rows while enforcing these invariants for every
-- new or changed record. A later data-cleanup migration can validate them.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_sprint1_amounts_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_sprint1_amounts_check
  CHECK (total_amount >= 0 AND paid_amount >= 0) NOT VALID;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_sprint1_schedule_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_sprint1_schedule_check
  CHECK (dt_to > dt_from) NOT VALID;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_sprint1_participants_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_sprint1_participants_check
  CHECK (guest_count > 0) NOT VALID;

ALTER TABLE booking_checkout_sessions DROP CONSTRAINT IF EXISTS booking_checkout_sessions_expiry_check;
ALTER TABLE booking_checkout_sessions ADD CONSTRAINT booking_checkout_sessions_expiry_check
  CHECK (expires_at > created_at) NOT VALID;

COMMENT ON TABLE booking_state_events IS
  'Append-only audit trail written by the centralized booking lifecycle service.';
COMMENT ON TABLE payment_state_events IS
  'Append-only audit trail written by the centralized booking payment lifecycle service.';
