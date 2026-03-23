CREATE TABLE IF NOT EXISTS booking_products (
  booking_id   uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   numeric(12,2) NOT NULL,
  PRIMARY KEY (booking_id, product_id)
);

CREATE TABLE IF NOT EXISTS product_resources (
  product_id   uuid NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,
  quantity     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, resource_id)
);

CREATE TABLE IF NOT EXISTS location_products (
  location_id  uuid NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  PRIMARY KEY (location_id, product_id)
);

CREATE TABLE IF NOT EXISTS client_group_members (
  group_id    uuid NOT NULL REFERENCES client_groups(group_id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, client_id)
);

CREATE TABLE IF NOT EXISTS booking_coupons (
  booking_id        uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  coupon_id         uuid NOT NULL REFERENCES coupons(coupon_id) ON DELETE RESTRICT,
  discount_applied  numeric(12,2) NOT NULL,
  PRIMARY KEY (booking_id, coupon_id)
);
