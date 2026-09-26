ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS client_group_id UUID;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_client_group_fk
        FOREIGN KEY (client_group_id)
            REFERENCES client_groups(group_id)
            ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_client_group
    ON bookings(client_group_id)
    WHERE client_group_id IS NOT NULL;
