ALTER TABLE reminder_rules
  ADD COLUMN IF NOT EXISTS whatsapp_template_name text,
  ADD COLUMN IF NOT EXISTS whatsapp_template_language text,
  ADD COLUMN IF NOT EXISTS whatsapp_parameter_mapping jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE reminder_deliveries
  ADD COLUMN IF NOT EXISTS messenger_message_id text,
  ADD COLUMN IF NOT EXISTS last_status_sync_at timestamptz;

ALTER TABLE reminder_deliveries DROP CONSTRAINT IF EXISTS reminder_deliveries_status_check;
ALTER TABLE reminder_deliveries
  ADD CONSTRAINT reminder_deliveries_status_check
  CHECK (status IN ('pending', 'processing', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'));

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_messenger_status
  ON reminder_deliveries(channel, status)
  WHERE channel = 'whatsapp' AND messenger_message_id IS NOT NULL;
