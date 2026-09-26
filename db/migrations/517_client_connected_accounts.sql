CREATE TABLE client_connected_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    client_id UUID NOT NULL
        REFERENCES clients(client_id)
        ON DELETE CASCADE,

    -- steam, discord, epic, etc.
    provider TEXT NOT NULL,

    external_user_id TEXT NOT NULL,

    display_name TEXT,
    avatar_url TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT client_connected_account_per_provider
        UNIQUE (client_id, provider),

    CONSTRAINT client_connected_account_external_unique
        UNIQUE (provider, external_user_id)
);

CREATE INDEX idx_client_connected_accounts_client
    ON client_connected_accounts(client_id);
