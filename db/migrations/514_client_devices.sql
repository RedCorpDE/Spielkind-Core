CREATE TABLE client_devices (
                                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                client_id UUID NOT NULL
                                    REFERENCES clients(client_id)
                                        ON DELETE CASCADE,

                                platform TEXT NOT NULL
                                    CHECK (platform IN ('ios', 'android', 'web')),

    -- expo, apns, fcm
                                push_provider TEXT,

                                push_token TEXT,

                                device_name TEXT,
                                device_model TEXT,
                                os_version TEXT,
                                app_version TEXT,

                                notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,

                                last_seen_at TIMESTAMPTZ,
                                revoked_at TIMESTAMPTZ,

                                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_devices_client
    ON client_devices(client_id);

CREATE UNIQUE INDEX uq_client_devices_push_token
    ON client_devices(push_provider, push_token)
    WHERE push_provider IS NOT NULL
      AND push_token IS NOT NULL;

CREATE INDEX idx_client_devices_active
    ON client_devices(client_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;
