-- Bookings
CREATE INDEX IF NOT EXISTS idx_bookings_client      ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_location    ON bookings(location_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status      ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dt_from     ON bookings(dt_from);
CREATE INDEX IF NOT EXISTS idx_bookings_source      ON bookings(source);
CREATE INDEX IF NOT EXISTS idx_bookings_dt_range    ON bookings USING gist (tstzrange(dt_from, dt_to));

-- Consumptions
CREATE INDEX IF NOT EXISTS idx_consumptions_resource ON consumptions(resource_id);
CREATE INDEX IF NOT EXISTS idx_consumptions_booking  ON consumptions(booking_id);
CREATE INDEX IF NOT EXISTS idx_consumptions_dt_range ON consumptions USING gist (tstzrange(dt_from, dt_to));

-- Payments
CREATE INDEX IF NOT EXISTS idx_payments_booking     ON payments(booking_id);

-- Resources
CREATE INDEX IF NOT EXISTS idx_resources_location   ON resources(location_id);
CREATE INDEX IF NOT EXISTS idx_resources_type       ON resources(type);

-- Regiondo mapping (partial indexes)
CREATE INDEX IF NOT EXISTS idx_bookings_regiondo    ON bookings(regiondo_booking_id)   WHERE regiondo_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_regiondo     ON clients(regiondo_customer_id)   WHERE regiondo_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_regiondo    ON products(regiondo_product_id)   WHERE regiondo_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_locations_regiondo   ON locations(regiondo_location_id) WHERE regiondo_location_id IS NOT NULL;

-- Sync log
CREATE INDEX IF NOT EXISTS idx_sync_log_type        ON sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_sync_log_started     ON sync_log(started_at DESC);
