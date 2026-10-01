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

Migration 527 added `product_offering_resources`. New writes are Offering-specific and enforce matching Resource and Offering Locations. Migration 530 adds Core capacity scaling (`per_quantity` by default, or `per_booking`) without changing participant-based pricing. `product_resources` remains an unchanged `per_quantity` fallback only when an Offering has no explicit requirements; both sources are never combined. Safe matching-location legacy mappings are backfilled idempotently and unresolved mappings are recorded in `product_offering_resource_migration_conflicts`.

See `resource-availability-architecture.md` for capacity resolution, rule behavior, APIs, and migration operations.

## Core-native pricing and Variant eligibility

Migration 532 adds Offering-level Core pricing modes: `once`, `per_quantity`,
`per_date_unit`, and `per_date_unit_per_quantity`. Existing Offerings default to
`per_quantity`, which preserves the previous base/Variant rate multiplied by
participant quantity. Date-unit modes are valid only for `date_range`
Offerings. `nights` counts the difference between Location-local calendar dates
with the departure date excluded; `calendar_days` counts both selected endpoint
dates. Both conventions have a minimum of one billable unit and avoid elapsed
24-hour calculations across DST transitions.

The selected Variant's price remains an absolute replacement for the Product
rate. Existing Option deltas remain additive per quantity and are not multiplied
by date units. Resource requirement scaling remains a separate concern:
`per_booking` still consumes one configured resource amount regardless of
participants or billable date units, while `per_quantity` follows participant
quantity.

Variants may be inactive or carry an eligibility rule based on ISO weekdays
(Monday `1` through Sunday `7`) and an optional start-time window. Eligibility
uses the resolved booking start in the Offering's IANA timezone. A window such
as `22:00`–`03:00` crosses midnight, but weekday evaluation still uses the
booking start date. Core validates the selected Variant during quote and again
during checkout; frontend filtering is only a convenience.

These Variant rules choose a package for the booking start. They do not provide
mixed nightly rates inside a multi-day booking. Per-calendar-date, seasonal,
holiday, special-event, occupancy-based, weekday/weekend-per-night,
minimum/maximum-night, arrival or
departure restrictions, blackout dates, advance-booking windows, and
discounted multi-day rates remain future work. If those are needed, introduce a
dedicated rate calendar/pricing-rule model rather than extending Variant
eligibility into per-date pricing.
