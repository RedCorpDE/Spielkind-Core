CREATE TABLE IF NOT EXISTS external_task_intake_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL DEFAULT 'client_email_service',
  external_message_id text NOT NULL,
  task_id             uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_hash        text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT external_task_intake_events_source_message_unique
    UNIQUE (source, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_external_task_intake_events_task_id
  ON external_task_intake_events(task_id);
