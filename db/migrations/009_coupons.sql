CREATE TABLE IF NOT EXISTS coupons (
  coupon_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  discount     numeric(12,2) NOT NULL CHECK (discount > 0),
  type         text NOT NULL CHECK (type IN ('fixed','percent')),
  valid_from   timestamptz,
  valid_to     timestamptz,
  max_uses     integer,
  times_used   integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now()
);
