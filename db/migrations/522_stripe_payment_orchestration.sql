-- Durable Stripe checkout/webhook orchestration and transactional outbox delivery.
-- Additive only: existing Regiondo/manual payment records remain untouched.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_payments_checkout_id
  ON payments(provider_checkout_id)
  WHERE provider = 'stripe' AND provider_checkout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_payments_payment_id
  ON payments(provider_payment_id)
  WHERE provider = 'stripe' AND provider_payment_id IS NOT NULL;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_events_dedupe_key
  ON outbox_events(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE access_credentials
  ADD COLUMN IF NOT EXISTS source_outbox_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_access_credentials_source_outbox_event
  ON access_credentials(source_outbox_event_id)
  WHERE source_outbox_event_id IS NOT NULL;

ALTER TABLE client_notifications
  ADD COLUMN IF NOT EXISTS source_outbox_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notifications_source_outbox_event
  ON client_notifications(source_outbox_event_id)
  WHERE source_outbox_event_id IS NOT NULL;
