# Product offerings

`location_products` is the persisted Product Offering domain relationship between a canonical Product and a Location. Products and Locations remain independently managed entities.

The table retains its existing `(location_id, product_id)` uniqueness for compatibility and also has a stable `product_offering_id`, `enabled`, `created_at`, and `updated_at`. Existing customer catalog filtering and commerce queries continue to use the same table.

The offering is the booking migration boundary. It owns `booking_provider`, the time-selection mode, timezone, participant limits, duration rules, advance rules, and same-day policy. Changing an offering from Regiondo to Core affects only new intents; historical bookings retain their immutable `bookings.booking_provider` and provider references.

Admin relationship operations use the canonical location-first routes:

- `GET /api/admin/locations/:locationId/products`
- `POST /api/admin/locations/:locationId/products/:productId`
- `PATCH /api/admin/locations/:locationId/products/:productId`
- `DELETE /api/admin/locations/:locationId/products/:productId`

The Product DTO includes the same relationships in `locations`, so the Dashboard's Location and Product perspectives do not maintain separate data.

`products.booking_provider` remains only as a catalog/backfill default during migration. Runtime quote, hold, and booking routing resolves `location_products.booking_provider`.

## Offering Resource requirements

Migration 527 added `product_offering_resources`. New writes are Offering-specific and enforce matching Resource and Offering Locations. `product_resources` remains an unchanged fallback only when an Offering has no explicit requirements; both sources are never combined. Safe matching-location legacy mappings are backfilled idempotently and unresolved mappings are recorded in `product_offering_resource_migration_conflicts`.

See `resource-availability-architecture.md` for capacity resolution, rule behavior, APIs, and migration operations.
