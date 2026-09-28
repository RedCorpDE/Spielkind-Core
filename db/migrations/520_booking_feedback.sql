CREATE TABLE IF NOT EXISTS booking_feedback (
  feedback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  overall_rating smallint NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  equipment_rating smallint CHECK (equipment_rating BETWEEN 1 AND 5),
  cleanliness_rating smallint CHECK (cleanliness_rating BETWEEN 1 AND 5),
  internet_rating smallint CHECK (internet_rating BETWEEN 1 AND 5),
  access_rating smallint CHECK (access_rating BETWEEN 1 AND 5),
  value_rating smallint CHECK (value_rating BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  public_review_consent boolean NOT NULL DEFAULT false,
  submitted_from text NOT NULL DEFAULT 'app'
    CHECK (submitted_from IN ('app', 'web', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_feedback_booking_client_unique UNIQUE (booking_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_feedback_booking_id ON booking_feedback(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_feedback_client_id ON booking_feedback(client_id);
CREATE INDEX IF NOT EXISTS idx_booking_feedback_created_at ON booking_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_feedback_overall_rating ON booking_feedback(overall_rating);

DROP TRIGGER IF EXISTS trg_booking_feedback_updated_at ON booking_feedback;
CREATE TRIGGER trg_booking_feedback_updated_at
  BEFORE UPDATE ON booking_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
