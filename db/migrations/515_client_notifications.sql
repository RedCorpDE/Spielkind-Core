CREATE TABLE client_notifications (
                                      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                      client_id UUID NOT NULL
                                          REFERENCES clients(client_id)
                                              ON DELETE CASCADE,

                                      type TEXT NOT NULL,

                                      title TEXT NOT NULL,
                                      body TEXT NOT NULL,

                                      booking_id UUID
                                                     REFERENCES bookings(booking_id)
                                                         ON DELETE SET NULL,

                                      group_id UUID
                                                     REFERENCES client_groups(group_id)
                                                         ON DELETE SET NULL,

    -- Internal app route, for example:
    -- /bookings/<uuid>
                                      deep_link TEXT,

                                      data JSONB NOT NULL DEFAULT '{}'::JSONB,

                                      read_at TIMESTAMPTZ,

                                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_notifications_client_created
    ON client_notifications(client_id, created_at DESC);

CREATE INDEX idx_client_notifications_unread
    ON client_notifications(client_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE INDEX idx_client_notifications_booking
    ON client_notifications(booking_id)
    WHERE booking_id IS NOT NULL;

CREATE INDEX idx_client_notifications_group
    ON client_notifications(group_id)
    WHERE group_id IS NOT NULL;
