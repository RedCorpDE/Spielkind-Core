CREATE TABLE client_group_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    group_id UUID NOT NULL
        REFERENCES client_groups(group_id)
        ON DELETE CASCADE,

    invited_by_client_id UUID
        REFERENCES clients(client_id)
        ON DELETE SET NULL,

    -- Optional because a generic share link / QR code may not
    -- target a specific account or email address.
    invited_client_id UUID
        REFERENCES clients(client_id)
        ON DELETE SET NULL,

    email TEXT,

    -- Store hash only. Raw invite token is only shown/sent once.
    token_hash TEXT NOT NULL UNIQUE,

    expires_at TIMESTAMPTZ NOT NULL,

    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_group_invites_group
    ON client_group_invites(group_id);

CREATE INDEX idx_client_group_invites_client
    ON client_group_invites(invited_client_id)
    WHERE invited_client_id IS NOT NULL;

CREATE INDEX idx_client_group_invites_email
    ON client_group_invites(LOWER(email))
    WHERE email IS NOT NULL;

CREATE INDEX idx_client_group_invites_active
    ON client_group_invites(group_id, expires_at)
    WHERE accepted_at IS NULL
      AND revoked_at IS NULL;
