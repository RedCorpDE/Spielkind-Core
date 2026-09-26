CREATE TABLE access_events (
                               id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Nullable because denied/unknown credentials may still
    -- create an access event.
                               credential_id UUID
                                           REFERENCES access_credentials(id)
                                               ON DELETE SET NULL,

                               booking_id UUID
                                           REFERENCES bookings(booking_id)
                                               ON DELETE SET NULL,

                               client_id UUID
                                           REFERENCES clients(client_id)
                                               ON DELETE SET NULL,

                               reader_id UUID
                                           REFERENCES access_readers(id)
                                               ON DELETE SET NULL,

                               action TEXT NOT NULL DEFAULT 'unlock'
                                   CHECK (
                                   action IN (
                                   'unlock',
                                   'lock',
                                   'check',
                                   'credential_sync'
                                   )
),

    result TEXT NOT NULL
        CHECK (
            result IN (
                'granted',
                'denied',
                'error'
            )
        ),

    failure_reason TEXT,

    external_provider TEXT,
    external_event_id TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_access_events_booking_time
    ON access_events(booking_id, occurred_at DESC)
    WHERE booking_id IS NOT NULL;

CREATE INDEX idx_access_events_client_time
    ON access_events(client_id, occurred_at DESC)
    WHERE client_id IS NOT NULL;

CREATE INDEX idx_access_events_reader_time
    ON access_events(reader_id, occurred_at DESC)
    WHERE reader_id IS NOT NULL;

CREATE INDEX idx_access_events_credential
    ON access_events(credential_id)
    WHERE credential_id IS NOT NULL;

CREATE UNIQUE INDEX uq_access_events_external
    ON access_events(external_provider, external_event_id)
    WHERE external_provider IS NOT NULL
      AND external_event_id IS NOT NULL;
