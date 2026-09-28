# Product offerings

`location_products` is the persisted Product Offering domain relationship between a canonical Product and a Location. Products and Locations remain independently managed entities.

The table retains its existing `(location_id, product_id)` uniqueness for compatibility and now also has a stable `product_offering_id`, `enabled`, `created_at`, and `updated_at`. Existing customer catalog filtering and commerce queries continue to use the same table.

Admin relationship operations use the canonical location-first routes:

- `GET /api/admin/locations/:locationId/products`
- `POST /api/admin/locations/:locationId/products/:productId`
- `DELETE /api/admin/locations/:locationId/products/:productId`

The Product DTO includes the same relationships in `locations`, so the Dashboard's Location and Product perspectives do not maintain separate data.

## Deferred additive fields

Future migrations can add nullable offering overrides without changing identity or uniqueness: price/currency, booking provider, availability rule, booking window, and metadata. Canonical Product values remain the default.

## Deferred resource migration

`product_resources` remains supported for backward compatibility. New mappings are checked against enabled offerings so a resource cannot be assigned from a location where the product is unavailable. A later migration should introduce `product_offering_resources`, migrate mappings per location, update availability queries, and only then retire global product-resource assumptions.
