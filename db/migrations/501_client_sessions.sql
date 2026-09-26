CREATE TABLE client_sessions (
                                 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                 client_id UUID NOT NULL
                                     REFERENCES clients(client_id)
                                         ON DELETE CASCADE,

                                 auth_identity_id UUID
                                                REFERENCES client_auth_identities(id)
                                                    ON DELETE SET NULL,

    -- Never store the raw refresh token.
                                 refresh_token_hash TEXT NOT NULL UNIQUE,

                                 device_id UUID,

                                 user_agent TEXT,
                                 ip_address INET,

                                 expires_at TIMESTAMPTZ NOT NULL,
                                 revoked_at TIMESTAMPTZ,
                                 last_used_at TIMESTAMPTZ,

                                 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_sessions_client
    ON client_sessions(client_id);

CREATE INDEX idx_client_sessions_active
    ON client_sessions(client_id, expires_at)
    WHERE revoked_at IS NULL;
