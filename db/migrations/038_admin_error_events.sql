CREATE TABLE IF NOT EXISTS admin_error_events (
  error_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id text,
  dedupe_key text UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  error_code text NOT NULL,
  message_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostic_summary text,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'anonymous', 'system', 'provider')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name text,
  actor_role text,
  operation text,
  http_status integer,
  entity_type text,
  entity_id text,
  booking_id uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  location_id uuid REFERENCES locations(location_id) ON DELETE SET NULL,
  regiondo_booking_key text,
  reminder_delivery_id uuid REFERENCES reminder_deliveries(reminder_delivery_id) ON DELETE SET NULL,
  job_run_id uuid REFERENCES job_runs(job_run_id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_admin_error_events_occurred
  ON admin_error_events(occurred_at DESC, error_event_id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_error_events_correlation
  ON admin_error_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_error_events_actor
  ON admin_error_events(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_error_events_source_severity
  ON admin_error_events(source, severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_error_events_booking
  ON admin_error_events(booking_id, occurred_at DESC) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_error_events_task
  ON admin_error_events(task_id, occurred_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_error_events_location
  ON admin_error_events(location_id, occurred_at DESC) WHERE location_id IS NOT NULL;
