-- Outbound log fuer Idempotenz und DSGVO-konformes Logging
-- Kein PII in dieser Tabelle -- nur IDs und Status
CREATE TABLE IF NOT EXISTS outbound_log (
  id           SERIAL PRIMARY KEY,
  booking_id   uuid NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,  -- 'client_message_7d', 'client_message_1d', 'check_out'
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id, trigger_type)
);

CREATE INDEX IF NOT EXISTS idx_outbound_log_status ON outbound_log(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_outbound_log_booking ON outbound_log(booking_id);

-- DSGVO: 90-Tage Retention via pg_cron oder scheduled cleanup
-- Eintraege werden nach 90 Tagen geloescht (Cleanup-Job separat)
