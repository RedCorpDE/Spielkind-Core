-- First-class Core cancellation policies, immutable booking policy contracts,
-- structured cancellation provenance, and staff-driven no-show handling.

ALTER TABLE cancellation_policies
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS no_show_grace_period_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_show_fee_type text NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS no_show_fee_value bigint NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE cancellation_policies DROP CONSTRAINT IF EXISTS cancellation_policies_no_show_grace_check;
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_no_show_grace_check
  CHECK (no_show_grace_period_minutes >= 0);
ALTER TABLE cancellation_policies DROP CONSTRAINT IF EXISTS cancellation_policies_no_show_fee_type_check;
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_no_show_fee_type_check
  CHECK (no_show_fee_type IN ('none', 'percentage', 'fixed_amount'));
ALTER TABLE cancellation_policies DROP CONSTRAINT IF EXISTS cancellation_policies_no_show_fee_value_check;
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_no_show_fee_value_check
  CHECK (no_show_fee_value >= 0);

-- Normalize legacy hour/refund-basis-point rules without changing their result.
UPDATE cancellation_policies policy
SET rules = COALESCE((
  SELECT jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'minimumMinutesBeforeStart', ((rule->>'minimumHoursBeforeStart')::numeric * 60)::integer,
      'feeType', CASE WHEN (rule->>'refundBasisPoints')::integer >= 10000 THEN 'none' ELSE 'percentage' END,
      'feeValue', CASE WHEN (rule->>'refundBasisPoints')::integer >= 10000 THEN NULL
        ELSE 100 - ((rule->>'refundBasisPoints')::integer / 100) END,
      'description', rule->>'reason'
    )) ORDER BY (rule->>'minimumHoursBeforeStart')::numeric DESC
  )
  FROM jsonb_array_elements(policy.rules) rule
), '[{"minimumMinutesBeforeStart":0,"feeType":"none"}]'::jsonb)
WHERE jsonb_typeof(policy.rules) = 'array'
  AND (jsonb_array_length(policy.rules) = 0 OR policy.rules->0 ? 'minimumHoursBeforeStart');

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancelled_by_type text,
  ADD COLUMN IF NOT EXISTS cancelled_by_admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason_code text,
  ADD COLUMN IF NOT EXISTS cancellation_note text,
  ADD COLUMN IF NOT EXISTS no_show_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancelled_by_type_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_cancelled_by_type_check
  CHECK (cancelled_by_type IS NULL OR cancelled_by_type IN ('customer', 'admin', 'system'));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancellation_reason_code_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_cancellation_reason_code_check
  CHECK (cancellation_reason_code IS NULL OR cancellation_reason_code IN (
    'customer_request', 'location_closed', 'technical_issue', 'duplicate',
    'staff_override', 'no_show', 'other'
  ));

CREATE INDEX IF NOT EXISTS idx_cancellation_policies_active
  ON cancellation_policies(is_active, archived_at, name);

