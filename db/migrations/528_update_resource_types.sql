-- Replace the legacy resource type vocabulary without rewriting migration 005.
ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_type_check;

UPDATE resources
SET type = CASE type
  WHEN 'pc-room' THEN 'room'
  WHEN 'bed-room' THEN 'sleeping_room'
  WHEN 'console-room' THEN 'console_station'
  WHEN 'beverages' THEN 'equipment'
  WHEN 'other' THEN 'custom'
  ELSE type
END;

ALTER TABLE resources
  ADD CONSTRAINT resources_type_check
  CHECK (type IN (
    'pc',
    'room',
    'sleeping_room',
    'console_station',
    'vr_headset',
    'projector',
    'area',
    'equipment',
    'custom'
  ));
