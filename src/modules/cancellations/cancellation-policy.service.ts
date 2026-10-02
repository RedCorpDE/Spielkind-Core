import { pool } from '../../db/pool.js';

export type CancellationFeeType = 'none' | 'percentage' | 'fixed_amount';

export interface CancellationPolicyRule {
  minimumMinutesBeforeStart: number;
  feeType: CancellationFeeType;
  feeValue?: number;
  description?: string;
}

export interface NoShowPolicy {
  gracePeriodMinutes: number;
  feeType: CancellationFeeType;
  feeValue?: number;
}

export interface CancellationPolicySnapshot {
  policyId: string | null;
  name: string;
  description: string | null;
  rules: CancellationPolicyRule[];
  noShow: NoShowPolicy;
  snapshottedAt: string;
}

export interface CancellationPolicyDto {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  archivedAt: string | null;
  cancellationRules: CancellationPolicyRule[];
  noShow: NoShowPolicy;
  productAssignments: Array<{ id: string; name: string }>;
  variantOverrides: Array<{ id: string; name: string; productId: string; productName: string }>;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CancellationPolicyInput {
  name: string;
  description?: string | null;
  active?: boolean;
  cancellationRules: CancellationPolicyRule[];
  noShow: NoShowPolicy;
}

export function validateCancellationRules(rules: CancellationPolicyRule[]): CancellationPolicyRule[] {
  if (!rules.length) throw new Error('At least one cancellation rule is required.');
  const normalized = rules.map((rule) => {
    if (!Number.isSafeInteger(rule.minimumMinutesBeforeStart) || rule.minimumMinutesBeforeStart < 0) {
      throw new Error('Cancellation thresholds must be non-negative integer minutes.');
    }
    validateFee(rule.feeType, rule.feeValue);
    return {
      minimumMinutesBeforeStart: rule.minimumMinutesBeforeStart,
      feeType: rule.feeType,
      ...(rule.feeType === 'none' ? {} : { feeValue: rule.feeValue }),
      ...(rule.description?.trim() ? { description: rule.description.trim() } : {})
    };
  }).sort((left, right) => right.minimumMinutesBeforeStart - left.minimumMinutesBeforeStart);
  if (new Set(normalized.map((rule) => rule.minimumMinutesBeforeStart)).size !== normalized.length) {
    throw new Error('Cancellation rule thresholds must be unique.');
  }
  if (normalized.at(-1)?.minimumMinutesBeforeStart !== 0) {
    throw new Error('Cancellation rules must include a zero-minute fallback.');
  }
  return normalized;
}

export function validateNoShowPolicy(noShow: NoShowPolicy): NoShowPolicy {
  if (!Number.isSafeInteger(noShow.gracePeriodMinutes) || noShow.gracePeriodMinutes < 0) {
    throw new Error('No-show grace period must be a non-negative integer number of minutes.');
  }
  validateFee(noShow.feeType, noShow.feeValue);
  return {
    gracePeriodMinutes: noShow.gracePeriodMinutes,
    feeType: noShow.feeType,
    ...(noShow.feeType === 'none' ? {} : { feeValue: noShow.feeValue })
  };
}

function validateFee(type: CancellationFeeType, value: number | undefined): void {
  if (type === 'none') return;
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) throw new Error('Fee values must be non-negative integers.');
  if (type === 'percentage' && (value ?? 101) > 100) throw new Error('Percentage fees must be between 0 and 100.');
}

function mapPolicy(row: Record<string, unknown>): CancellationPolicyDto {
  const products = Array.isArray(row.product_assignments) ? row.product_assignments as CancellationPolicyDto['productAssignments'] : [];
  const variants = Array.isArray(row.variant_overrides) ? row.variant_overrides as CancellationPolicyDto['variantOverrides'] : [];
  return {
    id: String(row.cancellation_policy_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    active: Boolean(row.is_active),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    cancellationRules: validateCancellationRules(Array.isArray(row.rules) ? row.rules as CancellationPolicyRule[] : []),
    noShow: validateNoShowPolicy({
      gracePeriodMinutes: Number(row.no_show_grace_period_minutes),
      feeType: row.no_show_fee_type as CancellationFeeType,
      feeValue: Number(row.no_show_fee_value)
    }),
    productAssignments: products,
    variantOverrides: variants,
    usageCount: products.length + variants.length,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

const policySelect = `
  SELECT policy.*,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', product_id, 'name', title) ORDER BY title)
      FROM products WHERE cancellation_policy_id = policy.cancellation_policy_id), '[]'::jsonb) AS product_assignments,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', variant.variant_id, 'name', COALESCE(variant.title, 'Default'),
      'productId', product.product_id, 'productName', product.title) ORDER BY product.title, variant.title)
      FROM product_variants variant INNER JOIN products product ON product.product_id = variant.product_id
      WHERE variant.cancellation_policy_id = policy.cancellation_policy_id), '[]'::jsonb) AS variant_overrides
  FROM cancellation_policies policy`;

export async function listCancellationPolicies(search?: string, includeArchived = false): Promise<CancellationPolicyDto[]> {
  const result = await pool.query(
    `${policySelect}
     WHERE ($1::boolean OR policy.archived_at IS NULL)
       AND ($2::text IS NULL OR policy.name ILIKE '%' || $2 || '%' OR policy.description ILIKE '%' || $2 || '%')
     ORDER BY policy.archived_at NULLS FIRST, policy.name`,
    [includeArchived, search?.trim() || null]
  );
  return result.rows.map(mapPolicy);
}

export async function getCancellationPolicy(id: string): Promise<CancellationPolicyDto | null> {
  const result = await pool.query(`${policySelect} WHERE policy.cancellation_policy_id = $1`, [id]);
  return result.rows[0] ? mapPolicy(result.rows[0]) : null;
}

export async function createCancellationPolicy(input: CancellationPolicyInput): Promise<CancellationPolicyDto> {
  const rules = validateCancellationRules(input.cancellationRules);
  const noShow = validateNoShowPolicy(input.noShow);
  const result = await pool.query<{ cancellation_policy_id: string }>(
    `INSERT INTO cancellation_policies (
       name, description, rules, is_active, no_show_grace_period_minutes, no_show_fee_type, no_show_fee_value
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING cancellation_policy_id`,
    [input.name.trim(), input.description?.trim() || null, JSON.stringify(rules), input.active ?? true,
      noShow.gracePeriodMinutes, noShow.feeType, noShow.feeValue ?? 0]
  );
  return (await getCancellationPolicy(result.rows[0].cancellation_policy_id))!;
}

export async function updateCancellationPolicy(id: string, input: CancellationPolicyInput): Promise<CancellationPolicyDto | null> {
  const rules = validateCancellationRules(input.cancellationRules);
  const noShow = validateNoShowPolicy(input.noShow);
  const result = await pool.query(
    `UPDATE cancellation_policies SET name = $2, description = $3, rules = $4::jsonb, is_active = $5,
       no_show_grace_period_minutes = $6, no_show_fee_type = $7, no_show_fee_value = $8,
       archived_at = CASE WHEN $5 THEN NULL ELSE archived_at END, updated_at = now()
     WHERE cancellation_policy_id = $1`,
    [id, input.name.trim(), input.description?.trim() || null, JSON.stringify(rules), input.active ?? true,
      noShow.gracePeriodMinutes, noShow.feeType, noShow.feeValue ?? 0]
  );
  return result.rowCount ? getCancellationPolicy(id) : null;
}

export async function duplicateCancellationPolicy(id: string): Promise<CancellationPolicyDto | null> {
  const source = await getCancellationPolicy(id);
  if (!source) return null;
  return createCancellationPolicy({
    name: `${source.name} (Copy)`, description: source.description, active: false,
    cancellationRules: source.cancellationRules, noShow: source.noShow
  });
}

export async function archiveCancellationPolicy(id: string): Promise<CancellationPolicyDto | null> {
  const policy = await getCancellationPolicy(id);
  if (!policy) return null;
  if (policy.usageCount > 0) throw new Error('Reassign Products and Variant overrides before archiving this policy.');
  await pool.query(
    `UPDATE cancellation_policies SET is_active = false, archived_at = COALESCE(archived_at, now()), updated_at = now()
     WHERE cancellation_policy_id = $1`, [id]
  );
  return getCancellationPolicy(id);
}

export async function resolveCancellationPolicySnapshot(
  client: { query: typeof pool.query }, productId: string, variantId?: string | null
): Promise<CancellationPolicySnapshot | null> {
  const result = await client.query<{
    cancellation_policy_id: string; name: string; description: string | null; rules: unknown;
    no_show_grace_period_minutes: number; no_show_fee_type: CancellationFeeType; no_show_fee_value: string | number;
  }>(
    `SELECT policy.cancellation_policy_id, policy.name, policy.description, policy.rules,
            policy.no_show_grace_period_minutes, policy.no_show_fee_type, policy.no_show_fee_value
     FROM products product
     LEFT JOIN product_variants variant ON variant.variant_id = $2 AND variant.product_id = product.product_id
     INNER JOIN cancellation_policies policy
       ON policy.cancellation_policy_id = COALESCE(variant.cancellation_policy_id, product.cancellation_policy_id)
     WHERE product.product_id = $1 AND policy.is_active = true AND policy.archived_at IS NULL`,
    [productId, variantId ?? null]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    policyId: row.cancellation_policy_id,
    name: row.name,
    description: row.description,
    rules: validateCancellationRules(Array.isArray(row.rules) ? row.rules as CancellationPolicyRule[] : []),
    noShow: validateNoShowPolicy({
      gracePeriodMinutes: row.no_show_grace_period_minutes,
      feeType: row.no_show_fee_type,
      feeValue: Number(row.no_show_fee_value)
    }),
    snapshottedAt: new Date().toISOString()
  };
}

export function policySummary(snapshot: Pick<CancellationPolicySnapshot, 'rules' | 'noShow'>): string[] {
  const fee = (rule: Pick<CancellationPolicyRule, 'feeType' | 'feeValue'>) =>
    rule.feeType === 'none' ? 'Free cancellation' : rule.feeType === 'percentage'
      ? `${rule.feeValue}% fee` : `${rule.feeValue} minor-unit fee`;
  return [
    ...snapshot.rules.map((rule) => `${rule.minimumMinutesBeforeStart} minutes or more before start: ${fee(rule)}`),
    `No-show after ${snapshot.noShow.gracePeriodMinutes} minutes: ${fee(snapshot.noShow)}`
  ];
}
