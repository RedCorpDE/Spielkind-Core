CREATE TABLE IF NOT EXISTS sync_log (
  sync_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type        text NOT NULL,
  status           text NOT NULL,
  records_synced   integer NOT NULL DEFAULT 0,
  error_message    text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
