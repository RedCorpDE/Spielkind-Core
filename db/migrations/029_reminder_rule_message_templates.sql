-- Repair reminder/job schema for databases that were baseline-marked
-- without actually applying migration 026, then add the new template field.
CREATE TABLE IF NOT EXISTS client_contact_methods (
  contact_method_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'telegram', 'sms', 'whatsapp')),
  destination text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  is_verified boolean NOT NULL DEFAULT false,
  provider_ref text,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, channel, destination)
);

CREATE INDEX IF NOT EXISTS idx_client_contact_methods_client
  ON client_contact_methods(client_id);

CREATE INDEX IF NOT EXISTS idx_client_contact_methods_channel
  ON client_contact_methods(channel)
  WHERE is_enabled = true;

CREATE TABLE IF NOT EXISTS reminder_rules (
  reminder_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  trigger_type text NOT NULL DEFAULT 'before_booking_start'
    CHECK (trigger_type IN ('before_booking_start')),
  offset_minutes integer NOT NULL CHECK (offset_minutes > 0),
  additional_channels text[] NOT NULL DEFAULT ARRAY[]::text[],
  reminder_type text NOT NULL,
  location_id uuid REFERENCES locations(location_id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(product_id) ON DELETE SET NULL,
  booking_statuses text[] NOT NULL DEFAULT ARRAY['confirmed']::text[],
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminder_rules_enabled
  ON reminder_rules(is_enabled)
  WHERE is_enabled = true;

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  reminder_delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_rule_id uuid NOT NULL REFERENCES reminder_rules(reminder_rule_id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'telegram', 'sms', 'whatsapp')),
  reminder_type text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  dedupe_key text NOT NULL UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  provider_response jsonb,
  locked_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_due
  ON reminder_deliveries(status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_booking
  ON reminder_deliveries(booking_id);

CREATE TABLE IF NOT EXISTS sync_state (
  sync_type text PRIMARY KEY,
  cursor_value text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  job_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  lock_key bigint,
  records_processed integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_runs_type_started
  ON job_runs(job_type, started_at DESC);

ALTER TABLE reminder_rules
  ADD COLUMN IF NOT EXISTS message_template text;

UPDATE reminder_rules
SET message_template = COALESCE(
  NULLIF(message_template, ''),
  'Hello {{client.firstName}}, this is a reminder for your booking at {{location.title}} on {{booking.startsAt}}.'
);

ALTER TABLE reminder_rules
  ALTER COLUMN message_template SET NOT NULL;
