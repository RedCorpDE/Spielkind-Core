-- Location-aware resource requirements for Product Offerings.
-- product_resources remains intact as the read fallback during migration.
CREATE TABLE IF NOT EXISTS product_offering_resources (
  product_offering_id uuid NOT NULL
    REFERENCES location_products(product_offering_id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_offering_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_product_offering_resources_resource
  ON product_offering_resources(resource_id);

DROP TRIGGER IF EXISTS trg_product_offering_resources_updated_at ON product_offering_resources;
CREATE TRIGGER trg_product_offering_resources_updated_at
  BEFORE UPDATE ON product_offering_resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Keep an explicit, queryable record of legacy mappings that cannot be copied
-- without guessing. Re-running this migration/backfill is idempotent.
CREATE TABLE IF NOT EXISTS product_offering_resource_migration_conflicts (
  product_id uuid NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,
  resource_location_id uuid NOT NULL REFERENCES locations(location_id) ON DELETE RESTRICT,
  reason text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, resource_id)
);

INSERT INTO product_offering_resources (product_offering_id, resource_id, quantity)
SELECT offering.product_offering_id, mapping.resource_id, mapping.quantity
FROM product_resources mapping
INNER JOIN resources resource ON resource.resource_id = mapping.resource_id
INNER JOIN location_products offering
  ON offering.product_id = mapping.product_id
 AND offering.location_id = resource.location_id
ON CONFLICT (product_offering_id, resource_id) DO NOTHING;

INSERT INTO product_offering_resource_migration_conflicts (
  product_id, resource_id, resource_location_id, reason
)
SELECT mapping.product_id, mapping.resource_id, resource.location_id,
       'No Product Offering exists at the Resource location; manual review required.'
FROM product_resources mapping
INNER JOIN resources resource ON resource.resource_id = mapping.resource_id
WHERE NOT EXISTS (
  SELECT 1
  FROM location_products offering
  WHERE offering.product_id = mapping.product_id
    AND offering.location_id = resource.location_id
)
ON CONFLICT (product_id, resource_id)
DO UPDATE SET reason = EXCLUDED.reason, detected_at = now();

COMMENT ON TABLE product_offering_resources IS
  'Location-aware capacity requirements. New writes use this table; product_resources is a legacy fallback.';
COMMENT ON TABLE product_offering_resource_migration_conflicts IS
  'Legacy Product Resource mappings that could not be assigned to an Offering without guessing.';
