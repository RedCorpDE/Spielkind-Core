CREATE TABLE IF NOT EXISTS task_booking_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  provider_key text NOT NULL DEFAULT 'regiondo',
  sub_id text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'submitting'
    CHECK (status IN ('submitting', 'pending_snapshot', 'completed', 'failed', 'needs_review')),
  booking_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  order_number text,
  purchase_data jsonb,
  booking_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  diagnostic_message text,
  diagnostic_details text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_booking_attempts_recovery
  ON task_booking_attempts (created_at ASC)
  WHERE status IN ('submitting', 'pending_snapshot');

DROP TRIGGER IF EXISTS trg_task_booking_attempts_updated_at ON task_booking_attempts;
CREATE TRIGGER trg_task_booking_attempts_updated_at
  BEFORE UPDATE ON task_booking_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
