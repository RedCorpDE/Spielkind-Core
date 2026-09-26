CREATE TABLE booking_participants (
                                      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                      booking_id UUID NOT NULL
                                          REFERENCES bookings(booking_id)
                                              ON DELETE CASCADE,

    -- NULL means this attendee is a guest without an app account.
                                      client_id UUID
                                                      REFERENCES clients(client_id)
                                                          ON DELETE SET NULL,

                                      invited_by_client_id UUID
                                                      REFERENCES clients(client_id)
                                                          ON DELETE SET NULL,

                                      display_name TEXT NOT NULL,
                                      email TEXT,

                                      status TEXT NOT NULL DEFAULT 'confirmed'
                                          CHECK (
                                              status IN (
                                                         'invited',
                                                         'confirmed',
                                                         'declined',
                                                         'checked_in'
                                                  )
                                              ),

                                      checked_in_at TIMESTAMPTZ,

                                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                                      CONSTRAINT booking_participant_display_name_not_empty
                                          CHECK (LENGTH(TRIM(display_name)) > 0)
);

CREATE INDEX idx_booking_participants_booking
    ON booking_participants(booking_id);

CREATE INDEX idx_booking_participants_client
    ON booking_participants(client_id)
    WHERE client_id IS NOT NULL;

CREATE UNIQUE INDEX uq_booking_participant_registered_client
    ON booking_participants(booking_id, client_id)
    WHERE client_id IS NOT NULL;
