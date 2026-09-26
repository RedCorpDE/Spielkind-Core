CREATE TABLE client_preferences (
                                    client_id UUID PRIMARY KEY
                                        REFERENCES clients(client_id)
                                            ON DELETE CASCADE,

                                    locale TEXT NOT NULL DEFAULT 'de-DE',

                                    theme TEXT NOT NULL DEFAULT 'system'
                                        CHECK (
                                            theme IN (
                                                      'system',
                                                      'light',
                                                      'dark'
                                                )
                                            ),

                                    booking_reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                                    access_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                                    group_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                                    marketing_notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,

                                    onboarding_completed_at TIMESTAMPTZ,

                                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
