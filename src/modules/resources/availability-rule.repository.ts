import { pool } from '../../db/pool.js';
import type { Queryable } from './resource-requirements.repository.js';

export interface AvailabilityRule {
  ruleId: string; locationId: string | null; productId: string | null;
  productVariantId: string | null; resourceId: string | null;
  ruleType: 'recurring' | 'date_range' | 'manual_block';
  startsAt: string | null; endsAt: string | null; weekdays: number[] | null;
  localStartTime: string | null; localEndTime: string | null; timezone: string;
  capacityOverride: number | null; isActive: boolean; metadata: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

export type AvailabilityRuleInput = Omit<AvailabilityRule, 'ruleId' | 'createdAt' | 'updatedAt'>;

interface RuleRow {
  availability_rule_id: string; location_id: string | null; product_id: string | null;
  product_variant_id: string | null; resource_id: string | null; rule_type: AvailabilityRule['ruleType'];
  starts_at: string | null; ends_at: string | null; weekdays: number[] | null;
  local_start_time: string | null; local_end_time: string | null; timezone: string;
  capacity_override: number | null; is_active: boolean; metadata: Record<string, unknown>;
  created_at: string; updated_at: string;
}

function mapRule(row: RuleRow): AvailabilityRule {
  return {
    ruleId: row.availability_rule_id, locationId: row.location_id, productId: row.product_id,
    productVariantId: row.product_variant_id, resourceId: row.resource_id, ruleType: row.rule_type,
    startsAt: row.starts_at, endsAt: row.ends_at, weekdays: row.weekdays,
    localStartTime: row.local_start_time, localEndTime: row.local_end_time,
    timezone: row.timezone, capacityOverride: row.capacity_override === null ? null : Number(row.capacity_override),
    isActive: row.is_active, metadata: row.metadata ?? {}, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

const selectRule = `SELECT availability_rule_id, location_id, product_id, product_variant_id,
  resource_id, rule_type, starts_at, ends_at, weekdays, local_start_time, local_end_time,
  timezone, capacity_override, is_active, metadata, created_at, updated_at
FROM availability_rules`;

export async function listAvailabilityRules(filters: { locationId?: string; productId?: string; resourceId?: string }): Promise<AvailabilityRule[]> {
  const result = await pool.query<RuleRow>(
    `${selectRule}
     WHERE ($1::uuid IS NULL OR location_id = $1)
       AND ($2::uuid IS NULL OR product_id = $2)
       AND ($3::uuid IS NULL OR resource_id = $3)
     ORDER BY created_at DESC`,
    [filters.locationId ?? null, filters.productId ?? null, filters.resourceId ?? null]
  );
  return result.rows.map(mapRule);
}

export async function createAvailabilityRule(input: AvailabilityRuleInput): Promise<AvailabilityRule | null> {
  const result = await pool.query<RuleRow>(
    `INSERT INTO availability_rules (
       location_id, product_id, product_variant_id, resource_id, rule_type,
       starts_at, ends_at, weekdays, local_start_time, local_end_time, timezone,
       capacity_override, is_active, metadata
     )
     SELECT $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::smallint[],
            $9::time, $10::time, $11, $12, $13, $14::jsonb
     WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM locations WHERE location_id = $1))
       AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM products WHERE product_id = $2))
       AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM product_variants WHERE variant_id = $3))
       AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM resources resource
         WHERE resource.resource_id = $4 AND ($1::uuid IS NULL OR resource.location_id = $1)
       ))
     RETURNING *`,
    [input.locationId, input.productId, input.productVariantId, input.resourceId, input.ruleType,
      input.startsAt, input.endsAt, input.weekdays, input.localStartTime, input.localEndTime,
      input.timezone, input.capacityOverride, input.isActive, JSON.stringify(input.metadata)]
  );
  return result.rowCount ? mapRule(result.rows[0]) : null;
}

export async function updateAvailabilityRule(ruleId: string, input: AvailabilityRuleInput): Promise<AvailabilityRule | null> {
  const result = await pool.query<RuleRow>(
    `UPDATE availability_rules SET location_id = $2, product_id = $3, product_variant_id = $4,
       resource_id = $5, rule_type = $6, starts_at = $7::timestamptz, ends_at = $8::timestamptz,
       weekdays = $9::smallint[], local_start_time = $10::time, local_end_time = $11::time,
       timezone = $12, capacity_override = $13, is_active = $14, metadata = $15::jsonb,
       updated_at = now()
     WHERE availability_rule_id = $1
       AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM locations WHERE location_id = $2))
       AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM products WHERE product_id = $3))
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM product_variants WHERE variant_id = $4))
       AND ($5::uuid IS NULL OR EXISTS (
         SELECT 1 FROM resources resource
         WHERE resource.resource_id = $5 AND ($2::uuid IS NULL OR resource.location_id = $2)
       ))
     RETURNING *`,
    [ruleId, input.locationId, input.productId, input.productVariantId, input.resourceId, input.ruleType,
      input.startsAt, input.endsAt, input.weekdays, input.localStartTime, input.localEndTime,
      input.timezone, input.capacityOverride, input.isActive, JSON.stringify(input.metadata)]
  );
  return result.rowCount ? mapRule(result.rows[0]) : null;
}

export async function deleteAvailabilityRule(ruleId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM availability_rules WHERE availability_rule_id = $1`, [ruleId]);
  return Boolean(result.rowCount);
}

/** Resolve active full/partial manual blocks for an exact requested interval. */
export async function loadManualBlockCapacities(
  queryable: Queryable,
  input: {
    resourceIds: string[]; locationId: string; productId?: string;
    startsAt: string; endsAt: string;
  }
): Promise<Map<string, number>> {
  if (!input.resourceIds.length) return new Map();
  const result = await queryable.query<{ resource_id: string; capacity_override: string | number }>(
    `SELECT target.resource_id, MIN(COALESCE(rule.capacity_override, 0)) AS capacity_override
     FROM unnest($1::uuid[]) AS target(resource_id)
     INNER JOIN availability_rules rule
       ON rule.is_active = true
      AND rule.rule_type = 'manual_block'
      AND (rule.location_id IS NULL OR rule.location_id = $2)
      AND (rule.product_id IS NULL OR rule.product_id = $3)
      AND rule.product_variant_id IS NULL
      AND (rule.resource_id IS NULL OR rule.resource_id = target.resource_id)
      AND rule.starts_at < $5::timestamptz
      AND rule.ends_at > $4::timestamptz
     GROUP BY target.resource_id`,
    [input.resourceIds, input.locationId, input.productId ?? null, input.startsAt, input.endsAt]
  );
  return new Map(result.rows.map((row) => [row.resource_id, Number(row.capacity_override)]));
}

/**
 * Positive recurring/date-range rules are optional constraints. If a scope has
 * no positive rules it remains open for backwards compatibility; once rules
 * exist, the requested interval must fit one Location window and one Product
 * (Offering) window for the scopes that are configured.
 */
export async function isIntervalAllowedByAvailabilityRules(
  queryable: Queryable,
  input: {
    locationId: string; productId: string; productVariantId?: string;
    startsAt: string; endsAt: string;
  }
): Promise<boolean> {
  const result = await queryable.query<{
    location_count: string | number; location_matches: boolean;
    product_count: string | number; product_matches: boolean;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE product_id IS NULL) AS location_count,
       COALESCE(BOOL_OR(
         product_id IS NULL AND (
           (rule_type = 'date_range' AND starts_at <= $4::timestamptz AND ends_at >= $5::timestamptz)
           OR
           (rule_type = 'recurring'
             AND EXTRACT(ISODOW FROM ($4::timestamptz AT TIME ZONE timezone))::smallint = ANY(weekdays)
             AND ($4::timestamptz AT TIME ZONE timezone)::date = ($5::timestamptz AT TIME ZONE timezone)::date
             AND ($4::timestamptz AT TIME ZONE timezone)::time >= local_start_time
             AND ($5::timestamptz AT TIME ZONE timezone)::time <= local_end_time)
         )
       ), false) AS location_matches,
       COUNT(*) FILTER (WHERE product_id = $2) AS product_count,
       COALESCE(BOOL_OR(
         product_id = $2 AND (
           (rule_type = 'date_range' AND starts_at <= $4::timestamptz AND ends_at >= $5::timestamptz)
           OR
           (rule_type = 'recurring'
             AND EXTRACT(ISODOW FROM ($4::timestamptz AT TIME ZONE timezone))::smallint = ANY(weekdays)
             AND ($4::timestamptz AT TIME ZONE timezone)::date = ($5::timestamptz AT TIME ZONE timezone)::date
             AND ($4::timestamptz AT TIME ZONE timezone)::time >= local_start_time
             AND ($5::timestamptz AT TIME ZONE timezone)::time <= local_end_time)
         )
       ), false) AS product_matches
     FROM availability_rules
     WHERE is_active = true
       AND rule_type IN ('recurring', 'date_range')
       AND resource_id IS NULL
       AND (location_id IS NULL OR location_id = $1)
       AND (product_id IS NULL OR product_id = $2)
       AND (product_variant_id IS NULL OR ($3::uuid IS NOT NULL AND product_variant_id = $3))`,
    [input.locationId, input.productId, input.productVariantId ?? null, input.startsAt, input.endsAt]
  );
  const row = result.rows[0];
  if (!row) return true;
  return (Number(row.location_count) === 0 || row.location_matches)
    && (Number(row.product_count) === 0 || row.product_matches);
}
