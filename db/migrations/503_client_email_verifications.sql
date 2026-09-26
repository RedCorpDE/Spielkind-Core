CREATE TABLE client_email_verifications (
                                            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                            client_id UUID NOT NULL
                                                REFERENCES clients(client_id)
                                                    ON DELETE CASCADE,

                                            auth_identity_id UUID
                                                REFERENCES client_auth_identities(id)
                                                    ON DELETE CASCADE,

                                            email TEXT NOT NULL,

    -- Store a cryptographic hash only.
                                            token_hash TEXT NOT NULL UNIQUE,

                                            expires_at TIMESTAMPTZ NOT NULL,
                                            consumed_at TIMESTAMPTZ,

                                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_email_verifications_client
    ON client_email_verifications(client_id);

CREATE INDEX idx_client_email_verifications_active
    ON client_email_verifications(expires_at)
    WHERE consumed_at IS NULL;
