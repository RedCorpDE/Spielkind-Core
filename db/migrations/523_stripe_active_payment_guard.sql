-- A booking can retry failed/cancelled payments, but may only expose one live Stripe checkout at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_active_payment_per_booking
  ON payments(booking_id)
  WHERE provider = 'stripe' AND status IN ('requires_payment', 'processing');
