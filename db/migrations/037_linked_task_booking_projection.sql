-- Seed the local task projection from its primary booking. This migration never
-- calls Regiondo; future operator saves coordinate all records in the link group.
WITH primary_booking_projection AS (
  SELECT
    t.id AS task_id,
    b.dt_from,
    b.dt_to,
    b.guest_count,
    b.location_id,
    COALESCE(l.title, '') AS site,
    c.first_name,
    c.last_name,
    c.email::text AS email,
    c.phone_number
  FROM tasks t
  INNER JOIN bookings b ON b.booking_id = t.connected_booking_key
  INNER JOIN clients c ON c.client_id = b.client_id
  LEFT JOIN locations l ON l.location_id = b.location_id
  WHERE t.is_deleted = false
)
UPDATE tasks t
SET event_date_time = projection.dt_from,
    raw_json = (
      COALESCE(t.raw_json, '{}'::jsonb)
      || jsonb_build_object('site', projection.site)
      || jsonb_build_object(
        'booking_data',
        COALESCE(t.raw_json -> 'booking_data', '{}'::jsonb)
        || jsonb_build_object(
          'attendees', projection.guest_count,
          'booking_end_date_time', projection.dt_to,
          'location_id', projection.location_id,
          'secondary_event_time', to_char(projection.dt_to AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
          'site', projection.site,
          'email', COALESCE(NULLIF(t.raw_json #>> '{booking_data,email}', ''), projection.email, ''),
          'phone_number', COALESCE(projection.phone_number, ''),
          'contact_data',
          COALESCE(t.raw_json #> '{booking_data,contact_data}', '{}'::jsonb)
          || jsonb_build_object(
            'first_name', COALESCE(projection.first_name, ''),
            'last_name', COALESCE(projection.last_name, ''),
            'phone_number', COALESCE(projection.phone_number, '')
          )
        )
      )
    )
FROM primary_booking_projection projection
WHERE t.id = projection.task_id;

DO $$
DECLARE
  divergent_group_count integer;
BEGIN
  SELECT COUNT(*)
  INTO divergent_group_count
  FROM (
    SELECT tb.task_id
    FROM task_bookings tb
    INNER JOIN bookings b ON b.booking_id = tb.booking_id
    GROUP BY tb.task_id
    HAVING COUNT(DISTINCT (b.dt_from, b.dt_to, b.guest_count, b.location_id, b.client_id)) > 1
  ) divergent_groups;

  RAISE NOTICE 'Linked task backfill found % multi-booking group(s) with divergent shared data.', divergent_group_count;
END $$;
