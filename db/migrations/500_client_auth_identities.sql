CREATE TABLE client_auth_identities (
                                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                        client_id UUID NOT NULL
                                            REFERENCES clients(client_id)
                                                ON DELETE CASCADE,

    -- password, apple, google, etc.
                                        provider TEXT NOT NULL,

    -- External/provider-specific identifier.
    -- For password auth this can be the normalized email.
                                        provider_subject TEXT NOT NULL,

                                        email TEXT,

    -- NULL for OAuth/social identities.
                                        password_hash TEXT,

                                        email_verified_at TIMESTAMPTZ,

                                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                                        CONSTRAINT client_auth_identities_provider_subject_unique
                                            UNIQUE (provider, provider_subject)
);

CREATE INDEX idx_client_auth_identities_client
    ON client_auth_identities(client_id);

CREATE INDEX idx_client_auth_identities_email
    ON client_auth_identities(LOWER(email))
    WHERE email IS NOT NULL;

CREATE UNIQUE INDEX uq_client_password_identity_email
    ON client_auth_identities(LOWER(email))
    WHERE provider = 'password' AND email IS NOT NULL;
