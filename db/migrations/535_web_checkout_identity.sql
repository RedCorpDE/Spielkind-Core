-- Bind WordPress checkout/idempotency state to the authenticated Core client.
-- NULL deliberately means guest checkout; guest ownership continues to use the
-- existing client/contact model created by the web checkout service.

ALTER TABLE booking_checkout_sessions
  ADD COLUMN IF NOT EXISTS authenticated_client_id uuid REFERENCES clients(client_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_booking_checkout_sessions_authenticated_client
  ON booking_checkout_sessions(authenticated_client_id)
  WHERE authenticated_client_id IS NOT NULL;

ALTER TABLE web_checkout_idempotency
  ADD COLUMN IF NOT EXISTS authenticated_client_id uuid REFERENCES clients(client_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_web_checkout_idempotency_authenticated_client
  ON web_checkout_idempotency(authenticated_client_id)
  WHERE authenticated_client_id IS NOT NULL;
