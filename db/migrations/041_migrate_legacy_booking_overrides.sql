INSERT INTO booking_change_requests (
  change_request_id, booking_id, provider_key, requested_by, requested_at, changes, status, completed_at, resolution
)
SELECT
  gen_random_uuid(),
  admin.booking_id,
  'regiondo',
  'Legacy local override',
  COALESCE(admin.provider_update_at, now()),
  jsonb_build_object(
    'legacy_override', jsonb_build_object(
      'from', COALESCE(admin.provider_update_changed_fields, '[]'::jsonb),
      'to', 'Review the current booking against Regiondo before applying this legacy edit.'
    )
  ),
  'conflict',
  now(),
  jsonb_build_object('source', 'legacy_local_override', 'message', admin.provider_update_message)
FROM booking_admin_metadata admin
INNER JOIN bookings booking ON booking.booking_id = admin.booking_id
INNER JOIN clients client ON client.client_id = booking.client_id
WHERE booking.source = 'regiondo'
  AND (
    admin.provider_update_outcome = 'not_supported'
    OR cardinality(COALESCE(admin.local_override_fields, ARRAY[]::text[])) > 0
    OR cardinality(COALESCE(client.local_override_fields, ARRAY[]::text[])) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM booking_change_requests request
    WHERE request.booking_id = admin.booking_id
  );

UPDATE booking_admin_metadata
SET local_override_fields = ARRAY[]::text[],
    provider_update_outcome = NULL,
    provider_update_at = NULL,
    provider_update_changed_fields = '[]'::jsonb,
    provider_update_message = NULL;

UPDATE clients
SET local_override_fields = ARRAY[]::text[];
