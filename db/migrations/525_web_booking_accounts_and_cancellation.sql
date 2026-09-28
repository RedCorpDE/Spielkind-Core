-- Secure WordPress checkout/account/cancellation façade.
-- Additive except for the legacy clients.email uniqueness rule: guest contacts must
-- not be silently attached to an existing authenticated identity by email alone.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_email_key;
CREATE INDEX IF NOT EXISTS idx_clients_email_lookup ON clients (LOWER(email::text)) WHERE email IS NOT NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS created_by_client_id uuid REFERENCES clients(client_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_client_id uuid REFERENCES clients(client_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS booking_source text NOT NULL DEFAULT 'other';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check CHECK (payment_status IN (
  'unpaid', 'processing', 'paid', 'failed', 'refund_pending',
  'partially_refunded', 'refunded', 'refund_failed'
));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_source_check CHECK (
  booking_source IN ('native_app', 'wordpress', 'dashboard', 'other')
);

UPDATE bookings SET booking_source = CASE source
  WHEN 'app' THEN 'native_app'
  WHEN 'manual' THEN 'dashboard'
  WHEN 'self-service' THEN 'wordpress'
  ELSE 'other'
END WHERE booking_source = 'other';

UPDATE bookings booking SET payment_status = COALESCE((
  SELECT CASE payment.status
    WHEN 'succeeded' THEN 'paid'
    WHEN 'processing' THEN 'processing'
    WHEN 'failed' THEN 'failed'
    WHEN 'partially_refunded' THEN 'partially_refunded'
    WHEN 'refunded' THEN 'refunded'
    ELSE 'unpaid'
  END
  FROM payments payment WHERE payment.booking_id = booking.booking_id
  ORDER BY payment.created_at DESC LIMIT 1
), 'unpaid');

CREATE INDEX IF NOT EXISTS idx_bookings_created_by_client ON bookings(created_by_client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_reservation_expiry ON bookings(reservation_expires_at)
  WHERE status IN ('held', 'pending', 'payment_pending');

CREATE TABLE IF NOT EXISTS booking_checkout_sessions (
  checkout_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_checkout_sessions_booking ON booking_checkout_sessions(booking_id);

CREATE TABLE IF NOT EXISTS booking_management_tokens (
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_management_tokens_booking ON booking_management_tokens(booking_id);

CREATE TABLE IF NOT EXISTS web_checkout_idempotency (
  idempotency_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  booking_id uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('wordpress_service', 'client', 'guest', 'staff', 'stripe')),
  actor_id uuid,
  booking_id uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(client_id) ON DELETE SET NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_audit_events_booking ON web_audit_events(booking_id, created_at DESC);

