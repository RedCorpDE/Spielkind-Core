-- Additive foundation for provider-independent catalog, booking, payment and availability.
-- Legacy Regiondo columns and junction tables intentionally remain during migration.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS booking_provider text,
  ADD COLUMN IF NOT EXISTS price_minor bigint,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS vat_basis_points integer NOT NULL DEFAULT 1900;

UPDATE products
SET booking_provider = CASE WHEN regiondo_product_id IS NULL THEN 'core' ELSE 'regiondo' END
WHERE booking_provider IS NULL;
UPDATE products SET price_minor = ROUND(base_amount * 100)::bigint WHERE price_minor IS NULL;
ALTER TABLE products ALTER COLUMN booking_provider SET DEFAULT 'core';
ALTER TABLE products ALTER COLUMN booking_provider SET NOT NULL;
ALTER TABLE products ALTER COLUMN price_minor SET DEFAULT 0;
ALTER TABLE products ALTER COLUMN price_minor SET NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_booking_provider_check;
ALTER TABLE products ADD CONSTRAINT products_booking_provider_check CHECK (booking_provider IN ('core', 'regiondo'));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_currency_check;
ALTER TABLE products ADD CONSTRAINT products_currency_check CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_minor_check;
ALTER TABLE products ADD CONSTRAINT products_price_minor_check CHECK (price_minor IS NULL OR price_minor >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_vat_basis_points_check;
ALTER TABLE products ADD CONSTRAINT products_vat_basis_points_check CHECK (vat_basis_points BETWEEN 0 AND 10000);

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(product_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS price_minor bigint,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR';
UPDATE product_variants variant
SET product_id = product.product_id
FROM products product
WHERE variant.product_id IS NULL
  AND variant.regiondo_product_id = product.regiondo_product_id;
UPDATE product_variants SET price_minor = ROUND(price * 100)::bigint WHERE price_minor IS NULL;
ALTER TABLE product_variants ALTER COLUMN regiondo_variant_id DROP NOT NULL;
ALTER TABLE product_variants ALTER COLUMN regiondo_product_id DROP NOT NULL;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_price_minor_check;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_price_minor_check CHECK (price_minor IS NULL OR price_minor >= 0);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);

ALTER TABLE product_options
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(product_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(variant_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS price_delta_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR';
UPDATE product_options option_record
SET product_id = product.product_id
FROM products product
WHERE option_record.product_id IS NULL
  AND option_record.regiondo_product_id = product.regiondo_product_id;
UPDATE product_options option_record
SET variant_id = variant.variant_id
FROM product_variants variant
WHERE option_record.variant_id IS NULL
  AND option_record.regiondo_variant_id = variant.regiondo_variant_id
  AND option_record.regiondo_product_id = variant.regiondo_product_id;
ALTER TABLE product_options ALTER COLUMN regiondo_option_id DROP NOT NULL;
ALTER TABLE product_options ALTER COLUMN regiondo_product_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_options_product_id ON product_options(product_id);
CREATE INDEX IF NOT EXISTS idx_product_options_variant_id ON product_options(variant_id);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_provider text,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_policy_snapshot jsonb;
UPDATE bookings
SET booking_provider = CASE WHEN regiondo_booking_id IS NULL THEN 'core' ELSE 'regiondo' END
WHERE booking_provider IS NULL;
ALTER TABLE bookings ALTER COLUMN booking_provider SET DEFAULT 'core';
ALTER TABLE bookings ALTER COLUMN booking_provider SET NOT NULL;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_provider_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_provider_check CHECK (booking_provider IN ('core', 'regiondo'));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_currency_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_currency_check CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'draft', 'held', 'pending', 'payment_pending', 'processing', 'confirmed',
  'change_requested', 'cancel_requested', 'cancelled', 'canceled', 'checked_in',
  'completed', 'payment_failed', 'expired', 'rejected', 'unknown', 'no_show'
));
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_idempotency_key
  ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_booking_provider ON bookings(booking_provider);

ALTER TABLE resources ADD COLUMN IF NOT EXISTS operational_status text NOT NULL DEFAULT 'active';
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_operational_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_operational_status_check
  CHECK (operational_status IN ('active', 'out_of_service'));

CREATE TABLE IF NOT EXISTS provider_references (
  provider_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('regiondo', 'core', 'stripe', 'manual')),
  entity_type text NOT NULL CHECK (entity_type IN ('booking', 'location', 'product', 'product_variant', 'payment', 'refund')),
  entity_id uuid NOT NULL,
  external_id text NOT NULL,
  external_parent_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, entity_type, external_id),
  UNIQUE (provider, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_references_entity ON provider_references(entity_type, entity_id);

INSERT INTO provider_references (provider, entity_type, entity_id, external_id)
SELECT 'regiondo', 'location', location_id, regiondo_location_id FROM locations WHERE regiondo_location_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO provider_references (provider, entity_type, entity_id, external_id)
SELECT 'regiondo', 'product', product_id, regiondo_product_id FROM products WHERE regiondo_product_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO provider_references (provider, entity_type, entity_id, external_id, external_parent_id)
SELECT 'regiondo', 'product_variant', variant_id, regiondo_variant_id, regiondo_product_id
FROM product_variants WHERE regiondo_variant_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO provider_references (provider, entity_type, entity_id, external_id, external_parent_id)
SELECT 'regiondo', 'booking', booking_id, regiondo_booking_id, regiondo_order_number
FROM bookings WHERE regiondo_booking_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS booking_items (
  booking_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(product_id) ON DELETE RESTRICT,
  product_variant_id uuid REFERENCES product_variants(variant_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  product_name_snapshot text NOT NULL,
  variant_name_snapshot text,
  unit_price_net bigint NOT NULL CHECK (unit_price_net >= 0),
  unit_price_gross bigint NOT NULL CHECK (unit_price_gross >= 0),
  vat_basis_points integer NOT NULL CHECK (vat_basis_points BETWEEN 0 AND 10000),
  subtotal_net bigint NOT NULL CHECK (subtotal_net >= 0),
  tax_amount bigint NOT NULL CHECK (tax_amount >= 0),
  subtotal_gross bigint NOT NULL CHECK (subtotal_gross >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subtotal_gross = subtotal_net + tax_amount)
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking_id ON booking_items(booking_id);

CREATE TABLE IF NOT EXISTS booking_item_options (
  booking_item_option_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_item_id uuid NOT NULL REFERENCES booking_items(booking_item_id) ON DELETE CASCADE,
  product_option_id uuid REFERENCES product_options(option_id) ON DELETE SET NULL,
  option_name_snapshot text NOT NULL,
  value_snapshot text NOT NULL,
  price_delta_snapshot bigint NOT NULL DEFAULT 0,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_item_options_item_id ON booking_item_options(booking_item_id);

-- Backfill immutable snapshots from the legacy booking_products junction.
INSERT INTO booking_items (
  booking_id, product_id, quantity, product_name_snapshot,
  unit_price_net, unit_price_gross, vat_basis_points,
  subtotal_net, tax_amount, subtotal_gross, currency, metadata
)
SELECT
  bp.booking_id, bp.product_id, bp.quantity, p.title,
  ROUND((bp.unit_price * 100) / (1 + (p.vat_basis_points::numeric / 10000)))::bigint,
  ROUND(bp.unit_price * 100)::bigint,
  p.vat_basis_points,
  ROUND((bp.unit_price * bp.quantity * 100) / (1 + (p.vat_basis_points::numeric / 10000)))::bigint,
  ROUND(bp.unit_price * bp.quantity * 100)::bigint - ROUND((bp.unit_price * bp.quantity * 100) / (1 + (p.vat_basis_points::numeric / 10000)))::bigint,
  ROUND(bp.unit_price * bp.quantity * 100)::bigint,
  p.currency,
  jsonb_build_object('backfilledFrom', 'booking_products')
FROM booking_products bp
INNER JOIN products p ON p.product_id = bp.product_id
WHERE NOT EXISTS (
  SELECT 1 FROM booking_items item
  WHERE item.booking_id = bp.booking_id AND item.product_id = bp.product_id
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS amount_minor bigint,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS provider_checkout_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE payments SET provider = CASE WHEN provider_ref IS NULL THEN 'manual' ELSE 'regiondo' END WHERE provider IS NULL;
UPDATE payments SET status = 'succeeded' WHERE status IS NULL;
UPDATE payments SET amount_minor = ROUND(amount * 100)::bigint WHERE amount_minor IS NULL;
UPDATE payments SET provider_payment_id = provider_ref WHERE provider_payment_id IS NULL AND provider_ref IS NOT NULL;
ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'manual';
ALTER TABLE payments ALTER COLUMN provider SET NOT NULL;
ALTER TABLE payments ALTER COLUMN status SET DEFAULT 'requires_payment';
ALTER TABLE payments ALTER COLUMN status SET NOT NULL;
ALTER TABLE payments ALTER COLUMN amount_minor SET NOT NULL;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('regiondo', 'stripe', 'manual'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN (
  'requires_payment', 'processing', 'succeeded', 'failed', 'cancelled',
  'partially_refunded', 'refunded', 'disputed'
));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_minor_check;
ALTER TABLE payments ADD CONSTRAINT payments_amount_minor_check CHECK (amount_minor > 0);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_currency_check;
ALTER TABLE payments ADD CONSTRAINT payments_currency_check CHECK (currency ~ '^[A-Z]{3}$');
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency_key ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id
  ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS refunds (
  refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(payment_id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('regiondo', 'stripe', 'manual')),
  provider_refund_id text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_idempotency_key ON refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_provider_refund_id
  ON refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cancellation_policies (
  cancellation_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS cancellation_policy_id uuid REFERENCES cancellation_policies(cancellation_policy_id) ON DELETE SET NULL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS cancellation_policy_id uuid REFERENCES cancellation_policies(cancellation_policy_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS availability_rules (
  availability_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(location_id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(product_id) ON DELETE CASCADE,
  product_variant_id uuid REFERENCES product_variants(variant_id) ON DELETE CASCADE,
  resource_id uuid REFERENCES resources(resource_id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('recurring', 'date_range', 'manual_block')),
  starts_at timestamptz,
  ends_at timestamptz,
  weekdays smallint[],
  local_start_time time,
  local_end_time time,
  timezone text NOT NULL DEFAULT 'Europe/Berlin',
  capacity_override integer,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (capacity_override IS NULL OR capacity_override >= 0)
);
CREATE INDEX IF NOT EXISTS idx_availability_rules_scope ON availability_rules(product_id, location_id, resource_id);

CREATE TABLE IF NOT EXISTS reservation_holds (
  reservation_hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(client_id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES locations(location_id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  product_variant_id uuid REFERENCES product_variants(variant_id) ON DELETE RESTRICT,
  resource_id uuid REFERENCES resources(resource_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'released')),
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_reservation_holds_capacity
  ON reservation_holds(resource_id, starts_at, ends_at, expires_at) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_holds_idempotency_key
  ON reservation_holds(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reservation_hold_allocations (
  reservation_hold_id uuid NOT NULL REFERENCES reservation_holds(reservation_hold_id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,
  capacity_used integer NOT NULL CHECK (capacity_used > 0),
  PRIMARY KEY (reservation_hold_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_reservation_hold_allocations_resource
  ON reservation_hold_allocations(resource_id, reservation_hold_id);

CREATE TABLE IF NOT EXISTS discounts (
  discount_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  discount_type text NOT NULL CHECK (discount_type IN ('fixed', 'percentage')),
  amount_minor bigint,
  percentage_basis_points integer,
  currency text,
  valid_from timestamptz,
  valid_until timestamptz,
  usage_limit integer,
  usage_count integer NOT NULL DEFAULT 0,
  product_ids uuid[] NOT NULL DEFAULT '{}',
  location_ids uuid[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (percentage_basis_points IS NULL OR percentage_basis_points BETWEEN 0 AND 10000),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_discounts_code ON discounts(LOWER(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_events (
  integration_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retrying', 'processed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  related_booking_id uuid REFERENCES bookings(booking_id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_events_claim ON integration_events(status, available_at, created_at);

INSERT INTO integration_events (
  provider, external_event_id, event_type, payload, headers, received_at,
  processed_at, available_at, locked_at, status, attempt_count, last_error,
  related_booking_id, metadata, created_at, updated_at
)
SELECT
  'regiondo', event.dedupe_key, COALESCE(event.action_type, 'booking.updated'), event.payload, event.headers,
  event.created_at, event.processed_at, event.available_at, event.locked_at, event.status,
  event.attempt_count, event.last_error, booking.booking_id,
  jsonb_build_object('legacyRegiondoWebhookEventId', event.event_id, 'bookingKey', event.booking_key),
  event.created_at, event.updated_at
FROM regiondo_webhook_events event
LEFT JOIN bookings booking ON booking.regiondo_booking_id = event.booking_key
ON CONFLICT (provider, external_event_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_events_claim ON outbox_events(status, available_at, created_at);

DROP TRIGGER IF EXISTS trg_provider_references_updated_at ON provider_references;
CREATE TRIGGER trg_provider_references_updated_at BEFORE UPDATE ON provider_references
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_booking_items_updated_at ON booking_items;
CREATE TRIGGER trg_booking_items_updated_at BEFORE UPDATE ON booking_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_reservation_holds_updated_at ON reservation_holds;
CREATE TRIGGER trg_reservation_holds_updated_at BEFORE UPDATE ON reservation_holds
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
