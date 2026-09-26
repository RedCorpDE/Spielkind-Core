ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country_code text DEFAULT 'DE',
  ADD COLUMN IF NOT EXISTS latitude numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10, 7),

  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}',

  ADD COLUMN IF NOT EXISTS directions text,
  ADD COLUMN IF NOT EXISTS parking text,
  ADD COLUMN IF NOT EXISTS public_transport text,

  ADD COLUMN IF NOT EXISTS facilities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS house_rules text[] NOT NULL DEFAULT '{}',

  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS support_note text;


-- Move the existing single image into the new image array.
UPDATE locations
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND cardinality(image_urls) = 0;


ALTER TABLE locations
  ADD CONSTRAINT locations_country_code_length
  CHECK (
    country_code IS NULL
    OR char_length(country_code) = 2
  );
