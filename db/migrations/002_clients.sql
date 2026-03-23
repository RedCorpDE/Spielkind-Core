CREATE TABLE IF NOT EXISTS clients (
  client_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name               text NOT NULL,
  last_name                text NOT NULL,
  birthday                 date,
  email                    citext UNIQUE,
  phone_number             text,
  preferred_contact_type   text,
  subscribed_to_newsletter boolean NOT NULL DEFAULT false,

  regiondo_customer_id     text UNIQUE,
  regiondo_raw             jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
