CREATE TABLE IF NOT EXISTS payments (
  payment_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,

  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  type           text NOT NULL
    CHECK (type IN ('cash','card','paypal','sepa','bank_transfer','voucher','other')),

  provider_ref   text,

  created_at     timestamptz NOT NULL DEFAULT now()
);
