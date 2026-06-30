CREATE TABLE IF NOT EXISTS task_booking_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text NOT NULL,
  value text NOT NULL,
  label_en text NOT NULL,
  label_de text NOT NULL,
  position integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_booking_options_group_check
    CHECK (group_key IN ('catering_size', 'beverage_package', 'choice_block')),
  CONSTRAINT task_booking_options_value_check
    CHECK (btrim(value) <> '' AND value <> 'none'),
  CONSTRAINT task_booking_options_label_en_check
    CHECK (btrim(label_en) <> ''),
  CONSTRAINT task_booking_options_label_de_check
    CHECK (btrim(label_de) <> ''),
  CONSTRAINT task_booking_options_position_check
    CHECK (position >= 0),
  CONSTRAINT task_booking_options_group_value_unique
    UNIQUE (group_key, value),
  CONSTRAINT task_booking_options_group_position_unique
    UNIQUE (group_key, position)
);

CREATE INDEX IF NOT EXISTS idx_task_booking_options_group_key
  ON task_booking_options(group_key, position);

DROP TRIGGER IF EXISTS trg_task_booking_options_updated_at ON task_booking_options;
CREATE TRIGGER trg_task_booking_options_updated_at
  BEFORE UPDATE ON task_booking_options
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

INSERT INTO task_booking_options (group_key, value, label_en, label_de, position, is_active)
VALUES
  ('catering_size', 'size_m', 'Size M', 'Größe M', 0, true),
  ('catering_size', 'size_l', 'Size L', 'Größe L', 1, true),
  ('catering_size', 'size_xl', 'Size XL', 'Größe XL', 2, true),
  ('catering_size', 'cutlery_flat_rate', 'Cutlery flat rate', 'Besteckpauschale', 3, true),
  ('beverage_package', 'beverage_package', 'Beverage package', 'Getränkepaket', 0, true),
  ('beverage_package', 'all_inclusive', 'All inclusive', 'All Inclusive', 1, true),
  ('beverage_package', 'all_inclusive_plus', 'All inclusive Plus', 'All Inclusive Plus', 2, true),
  ('beverage_package', 'mixed', 'Mixed: arm bands + count', 'Gemischt: Armbänder + Anzahl', 3, true),
  ('choice_block', 'keep_talking', 'Keep Talking', 'Keep Talking', 0, true),
  ('choice_block', 'google_earth_vr', 'Google Earth VR', 'Google Earth VR', 1, true),
  ('choice_block', 'diner_duo', 'Diner Duo', 'Diner Duo', 2, true),
  ('choice_block', 'richies_plank', 'Richie''s Plank', 'Richie''s Plank', 3, true)
ON CONFLICT (group_key, value) DO NOTHING;
