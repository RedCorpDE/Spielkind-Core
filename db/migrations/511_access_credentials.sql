CREATE TABLE access_credentials (
                                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                    booking_id UUID NOT NULL
                                        REFERENCES bookings(booking_id)
                                            ON DELETE CASCADE,

                                    client_id UUID
                                                    REFERENCES clients(client_id)
                                                        ON DELETE SET NULL,

                                    participant_id UUID
                                                    REFERENCES booking_participants(id)
                                                        ON DELETE SET NULL,

    -- Avoid naming this NFC specifically so other access
    -- mechanisms can be supported later.
                                    credential_type TEXT NOT NULL
                                        CHECK (
                                            credential_type IN (
                                                                'nfc',
                                                                'wallet',
                                                                'qr',
                                                                'pin',
                                                                'external'
                                                )
                                            ),

                                    status TEXT NOT NULL DEFAULT 'pending'
                                        CHECK (
                                            status IN (
                                                       'pending',
                                                       'active',
                                                       'revoked',
                                                       'expired',
                                                       'disabled'
                                                )
                                            ),

                                    valid_from TIMESTAMPTZ NOT NULL,
                                    valid_until TIMESTAMPTZ NOT NULL,

                                    external_provider TEXT,
                                    external_credential_id TEXT,

    -- Optional opaque provider metadata.
    -- Never put raw secrets/private keys here.
                                    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

                                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                    revoked_at TIMESTAMPTZ,

                                    CONSTRAINT access_credentials_valid_window
                                        CHECK (valid_until > valid_from),

                                    CONSTRAINT access_credentials_subject_present
                                        CHECK (
                                            client_id IS NOT NULL
                                                OR participant_id IS NOT NULL
                                            )
);

CREATE INDEX idx_access_credentials_booking
    ON access_credentials(booking_id);

CREATE INDEX idx_access_credentials_client
    ON access_credentials(client_id)
    WHERE client_id IS NOT NULL;

CREATE INDEX idx_access_credentials_participant
    ON access_credentials(participant_id)
    WHERE participant_id IS NOT NULL;

CREATE INDEX idx_access_credentials_active_window
    ON access_credentials(valid_from, valid_until)
    WHERE status = 'active';

CREATE UNIQUE INDEX uq_access_credentials_external
    ON access_credentials(
                          external_provider,
                          external_credential_id
        )
    WHERE external_provider IS NOT NULL
      AND external_credential_id IS NOT NULL;
