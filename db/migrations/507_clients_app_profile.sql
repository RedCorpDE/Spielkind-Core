ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT;

UPDATE clients
SET display_name = NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '')
WHERE display_name IS NULL;
