-- Active Regiondo change requests are the source of truth for dashboard-local edits.
-- Rebuild the field guards that migration 041 intentionally cleared.
UPDATE booking_admin_metadata metadata
SET local_override_fields = active.fields,
    updated_at = now()
FROM (
  SELECT booking_id, array_agg(DISTINCT field) AS fields
  FROM booking_change_requests request,
       LATERAL jsonb_object_keys(request.changes) AS field
  WHERE request.status IN ('pending', 'conflict')
  GROUP BY booking_id
) active
WHERE metadata.booking_id = active.booking_id;

INSERT INTO booking_admin_metadata (booking_id, local_override_fields)
SELECT active.booking_id, active.fields
FROM (
  SELECT booking_id, array_agg(DISTINCT field) AS fields
  FROM booking_change_requests request,
       LATERAL jsonb_object_keys(request.changes) AS field
  WHERE request.status IN ('pending', 'conflict')
  GROUP BY booking_id
) active
ON CONFLICT (booking_id) DO NOTHING;

-- Materialize the scalar targets from requests created by the previous release.
UPDATE bookings booking
SET guest_count = COALESCE((request.changes #>> '{attendees,to}')::integer, booking.guest_count),
    dt_from = COALESCE((request.changes #>> '{schedule,to,bookingDate}')::timestamptz, booking.dt_from),
    dt_to = COALESCE((request.changes #>> '{schedule,to,bookingEndDate}')::timestamptz, booking.dt_to),
    total_amount = COALESCE((request.changes #>> '{payment,to,amountToPay}')::numeric, booking.total_amount),
    paid_amount = COALESCE((request.changes #>> '{payment,to,amountPaid}')::numeric, booking.paid_amount),
    updated_at = now()
FROM (
  SELECT DISTINCT ON (booking_id) booking_id, changes
  FROM booking_change_requests
  WHERE status IN ('pending', 'conflict')
  ORDER BY booking_id, requested_at DESC
) request
WHERE booking.source = 'regiondo'
  AND request.booking_id = booking.booking_id;

-- Location targets use Regiondo IDs and can be mapped back to the canonical local row.
UPDATE bookings booking
SET location_id = location.location_id,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (booking_id) booking_id, changes #>> '{location,to}' AS regiondo_location_id
  FROM booking_change_requests
  WHERE status IN ('pending', 'conflict') AND changes ? 'location'
  ORDER BY booking_id, requested_at DESC
) request
INNER JOIN locations location ON location.regiondo_location_id = request.regiondo_location_id
WHERE booking.booking_id = request.booking_id;

-- Replace product rows only when every requested Regiondo product ID resolves locally.
WITH latest AS (
  SELECT DISTINCT ON (booking_id) booking_id, changes -> 'products' -> 'to' AS products
  FROM booking_change_requests
  WHERE status IN ('pending', 'conflict') AND changes ? 'products'
  ORDER BY booking_id, requested_at DESC
), resolvable AS (
  SELECT latest.booking_id, latest.products
  FROM latest
  WHERE jsonb_typeof(latest.products) = 'array'
    AND jsonb_array_length(latest.products) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(latest.products) item
      LEFT JOIN products product ON product.regiondo_product_id = item ->> 'productId'
      WHERE product.product_id IS NULL
    )
)
DELETE FROM booking_products existing
USING resolvable
WHERE existing.booking_id = resolvable.booking_id;

WITH latest AS (
  SELECT DISTINCT ON (booking_id) booking_id, changes -> 'products' -> 'to' AS products
  FROM booking_change_requests
  WHERE status IN ('pending', 'conflict') AND changes ? 'products'
  ORDER BY booking_id, requested_at DESC
), resolvable AS (
  SELECT latest.booking_id, latest.products
  FROM latest
  WHERE jsonb_typeof(latest.products) = 'array'
    AND jsonb_array_length(latest.products) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(latest.products) item
      LEFT JOIN products product ON product.regiondo_product_id = item ->> 'productId'
      WHERE product.product_id IS NULL
    )
)
INSERT INTO booking_products (booking_id, product_id, quantity, unit_price)
SELECT resolvable.booking_id,
       product.product_id,
       GREATEST(1, COALESCE((item ->> 'quantity')::integer, 1)),
       COALESCE((item ->> 'unitPrice')::numeric, product.base_amount)
FROM resolvable
CROSS JOIN LATERAL jsonb_array_elements(resolvable.products) item
INNER JOIN products product ON product.regiondo_product_id = item ->> 'productId';

-- Requests that cannot be safely materialized remain visible for manual review.
UPDATE booking_change_requests request
SET status = 'conflict',
    resolution = COALESCE(request.resolution, '{}'::jsonb) || '{"backfill":"unresolvable"}'::jsonb
WHERE request.status IN ('pending', 'conflict')
  AND (
    (request.changes ? 'location'
      AND request.changes #>> '{location,to}' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM locations
        WHERE regiondo_location_id = request.changes #>> '{location,to}'
      ))
    OR
    (request.changes ? 'products' AND CASE
      WHEN jsonb_typeof(request.changes -> 'products' -> 'to') = 'array' THEN
        jsonb_array_length(request.changes -> 'products' -> 'to') = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(request.changes -> 'products' -> 'to') item
          LEFT JOIN products product ON product.regiondo_product_id = item ->> 'productId'
          WHERE product.product_id IS NULL
        )
      ELSE true
    END)
  );

-- Client override flags were booking-unsafe; contact targets now remain scoped to
-- booking_change_requests and are overlaid by the dashboard repository.
UPDATE clients SET local_override_fields = ARRAY[]::text[]
WHERE cardinality(COALESCE(local_override_fields, ARRAY[]::text[])) > 0;
