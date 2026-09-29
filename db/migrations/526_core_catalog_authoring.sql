-- A Core product may use one implicit/default variant. A NULL title is the
-- existing customer-API-compatible representation of that internal variant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_core_default
  ON product_variants(product_id)
  WHERE regiondo_variant_id IS NULL AND title IS NULL;

