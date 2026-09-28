import type { PoolClient } from 'pg';

export type ProviderReferenceEntityType = 'booking' | 'location' | 'product' | 'product_variant' | 'payment' | 'refund';

export async function upsertProviderReference(
  client: PoolClient,
  input: {
    provider: 'regiondo' | 'core' | 'stripe' | 'manual';
    entityType: ProviderReferenceEntityType;
    entityId: string;
    externalId: string;
    externalParentId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO provider_references (
       provider, entity_type, entity_id, external_id, external_parent_id, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (provider, entity_type, external_id)
     DO UPDATE SET entity_id = EXCLUDED.entity_id,
                   external_parent_id = EXCLUDED.external_parent_id,
                   metadata = provider_references.metadata || EXCLUDED.metadata,
                   updated_at = now()`,
    [
      input.provider,
      input.entityType,
      input.entityId,
      input.externalId,
      input.externalParentId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

