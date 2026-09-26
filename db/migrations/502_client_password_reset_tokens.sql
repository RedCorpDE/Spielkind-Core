CREATE TABLE client_password_reset_tokens (
                                              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                              client_id UUID NOT NULL
                                                  REFERENCES clients(client_id)
                                                      ON DELETE CASCADE,

                                              auth_identity_id UUID
                                                  REFERENCES client_auth_identities(id)
                                                      ON DELETE CASCADE,

    -- Store a cryptographic hash of the token, never the raw token.
                                              token_hash TEXT NOT NULL UNIQUE,

                                              expires_at TIMESTAMPTZ NOT NULL,
                                              consumed_at TIMESTAMPTZ,

                                              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_password_reset_client
    ON client_password_reset_tokens(client_id);

CREATE INDEX idx_client_password_reset_active
    ON client_password_reset_tokens(expires_at)
    WHERE consumed_at IS NULL;
