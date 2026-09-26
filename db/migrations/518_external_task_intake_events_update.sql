ALTER TABLE external_task_intake_events
    ADD COLUMN IF NOT EXISTS client_id UUID;

ALTER TABLE external_task_intake_events
    ADD COLUMN IF NOT EXISTS booking_id UUID;

ALTER TABLE external_task_intake_events
    ADD COLUMN IF NOT EXISTS resource_id UUID;

ALTER TABLE external_task_intake_events
    ADD COLUMN IF NOT EXISTS location_id UUID;


ALTER TABLE external_task_intake_events
    ADD CONSTRAINT external_task_intake_client_fk
        FOREIGN KEY (client_id)
            REFERENCES clients(client_id)
            ON DELETE SET NULL;

ALTER TABLE external_task_intake_events
    ADD CONSTRAINT external_task_intake_booking_fk
        FOREIGN KEY (booking_id)
            REFERENCES bookings(booking_id)
            ON DELETE SET NULL;

ALTER TABLE external_task_intake_events
    ADD CONSTRAINT external_task_intake_resource_fk
        FOREIGN KEY (resource_id)
            REFERENCES resources(resource_id)
            ON DELETE SET NULL;

ALTER TABLE external_task_intake_events
    ADD CONSTRAINT external_task_intake_location_fk
        FOREIGN KEY (location_id)
            REFERENCES locations(location_id)
            ON DELETE SET NULL;


CREATE INDEX IF NOT EXISTS idx_external_task_intake_client
    ON external_task_intake_events(client_id)
    WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_external_task_intake_booking
    ON external_task_intake_events(booking_id)
    WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_external_task_intake_resource
    ON external_task_intake_events(resource_id)
    WHERE resource_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_external_task_intake_location
    ON external_task_intake_events(location_id)
    WHERE location_id IS NOT NULL;
