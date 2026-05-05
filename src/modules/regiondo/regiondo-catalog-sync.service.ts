import { appConfig } from '../../config/env.js';
import { RegiondoApiError, RegiondoClient, regiondoClient } from './regiondo.client.js';
import {
  addDays,
  createRegiondoOptionCompositeKey,
  extractRegiondoAvailabilitySlots,
  extractRegiondoOptionsDeep,
  extractRegiondoVariations,
  normalizeRegiondoCatalogOption,
  normalizeRegiondoCatalogProduct,
  normalizeRegiondoCatalogVariation,
  toDateOnly,
  type RegiondoCatalogOptionRecord,
  type RegiondoCatalogProductRecord,
  type RegiondoCatalogVariationRecord
} from './regiondo-catalog-normalizer.js';

export interface RegiondoCatalogSyncStats {
  availoptionsSlotErrors: number;
  availoptionsWithoutSlotErrors: number;
  normalizedOptions: number;
  normalizedProducts: number;
  normalizedVariations: number;
  productDetailErrors: number;
  productDetailsFetched: number;
  productsFetched: number;
  variationAvailabilityErrors: number;
}

export interface RegiondoCatalogSyncFetchResult {
  errors: Array<{
    message: string;
    productId?: string;
    stage: string;
    variationId?: string;
  }>;
  products: RegiondoCatalogProductRecord[];
  stats: RegiondoCatalogSyncStats;
}

interface RegiondoCatalogSyncServiceOptions {
  availabilityRangeDays: number;
  client: RegiondoClient;
  maxOptionSlotsPerVariation: number;
  productDetailConcurrency: number;
  variationSyncConcurrency: number;
}

const DEFAULT_REGIONDO_CATALOG_SYNC_STATS: RegiondoCatalogSyncStats = {
  availoptionsSlotErrors: 0,
  availoptionsWithoutSlotErrors: 0,
  normalizedOptions: 0,
  normalizedProducts: 0,
  normalizedVariations: 0,
  productDetailErrors: 0,
  productDetailsFetched: 0,
  productsFetched: 0,
  variationAvailabilityErrors: 0
};

async function mapLimit<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (currentIndex < items.length) {
      const itemIndex = currentIndex;
      currentIndex += 1;
      results[itemIndex] = await mapper(items[itemIndex], itemIndex);
    }
  };

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

const buildDefaultOptions = (): RegiondoCatalogSyncServiceOptions => ({
  availabilityRangeDays: appConfig.REGIONDO_AVAILABILITY_RANGE_DAYS,
  client: regiondoClient,
  maxOptionSlotsPerVariation: appConfig.REGIONDO_OPTION_SLOT_LIMIT,
  productDetailConcurrency: appConfig.REGIONDO_PRODUCT_DETAIL_CONCURRENCY,
  variationSyncConcurrency: appConfig.REGIONDO_VARIATION_SYNC_CONCURRENCY
});

const addOptionRecord = (
  optionByCompositeKey: Map<string, RegiondoCatalogOptionRecord>,
  option: unknown,
  variation: RegiondoCatalogVariationRecord,
  source: {
    date?: string;
    source?: string;
    time?: string;
  }
) => {
  const optionRecord = normalizeRegiondoCatalogOption(
    option,
    variation.regiondoProductId,
    variation.regiondoVariantId,
    source
  );

  if (!optionRecord) {
    return;
  }

  const key = createRegiondoOptionCompositeKey({
    regiondoOptionId: optionRecord.regiondoOptionId,
    regiondoProductId: optionRecord.regiondoProductId,
    regiondoVariantId: optionRecord.regiondoVariantId
  });

  optionByCompositeKey.set(key, optionRecord);
};

async function enrichVariationOptions(
  variation: RegiondoCatalogVariationRecord,
  options: RegiondoCatalogSyncServiceOptions,
  stats: RegiondoCatalogSyncStats,
  errors: RegiondoCatalogSyncFetchResult['errors']
): Promise<RegiondoCatalogOptionRecord[]> {
  const optionByCompositeKey = new Map<string, RegiondoCatalogOptionRecord>();

  extractRegiondoOptionsDeep(variation.raw).forEach((option) => {
    addOptionRecord(
      optionByCompositeKey,
      option,
      variation,
      { source: 'product_detail_variation_static' }
    );
  });

  try {
    const rawOptions = await options.client.getAvailableOptions({
      variationId: variation.regiondoVariantId
    });

    extractRegiondoOptionsDeep(rawOptions).forEach((option) => {
      addOptionRecord(
        optionByCompositeKey,
        option,
        variation,
        { source: 'availoptions_without_slot' }
      );
    });
  } catch (error) {
    stats.availoptionsWithoutSlotErrors += 1;
    errors.push({
      message: error instanceof Error ? error.message : 'Unknown Regiondo availoptions error.',
      productId: variation.regiondoProductId,
      stage: 'availoptions_without_slot',
      variationId: variation.regiondoVariantId
    });
  }

  try {
    const now = new Date();
    const availability = await options.client.getVariationAvailability({
      from: toDateOnly(now) ?? new Date().toISOString().slice(0, 10),
      to: toDateOnly(addDays(now, options.availabilityRangeDays)) ?? new Date().toISOString().slice(0, 10),
      variationId: variation.regiondoVariantId
    });
    const slots = extractRegiondoAvailabilitySlots(availability, options.maxOptionSlotsPerVariation);

    for (const slot of slots) {
      try {
        const rawOptions = await options.client.getAvailableOptions({
          date: slot.date,
          time: slot.time,
          variationId: variation.regiondoVariantId
        });

        extractRegiondoOptionsDeep(rawOptions).forEach((option) => {
          addOptionRecord(
            optionByCompositeKey,
            option,
            variation,
            {
              date: slot.date,
              source: 'availoptions_with_slot',
              time: slot.time
            }
          );
        });
      } catch (error) {
        stats.availoptionsSlotErrors += 1;
        errors.push({
          message: error instanceof Error ? error.message : 'Unknown Regiondo slot availoptions error.',
          productId: variation.regiondoProductId,
          stage: 'availoptions_with_slot',
          variationId: variation.regiondoVariantId
        });
      }
    }
  } catch (error) {
    stats.variationAvailabilityErrors += 1;
    errors.push({
      message: error instanceof Error ? error.message : 'Unknown Regiondo availability error.',
      productId: variation.regiondoProductId,
      stage: 'variation_availability',
      variationId: variation.regiondoVariantId
    });
  }

  return [...optionByCompositeKey.values()];
}

export async function fetchRegiondoCatalogProducts(
  input: Partial<RegiondoCatalogSyncServiceOptions> = {}
): Promise<RegiondoCatalogSyncFetchResult> {
  const options = {
    ...buildDefaultOptions(),
    ...input
  };
  const stats: RegiondoCatalogSyncStats = { ...DEFAULT_REGIONDO_CATALOG_SYNC_STATS };
  const errors: RegiondoCatalogSyncFetchResult['errors'] = [];
  const productSummaries = await options.client.getCatalogProducts();
  stats.productsFetched = productSummaries.length;

  const products = await mapLimit(
    productSummaries,
    options.productDetailConcurrency,
    async (productSummary): Promise<RegiondoCatalogProductRecord | null> => {
      try {
        const detail = await options.client.getProductDetail(productSummary.product_id);
        stats.productDetailsFetched += 1;

        const productBase = normalizeRegiondoCatalogProduct({
          ...productSummary,
          ...(typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? detail : {})
        });

        if (!productBase) {
          return null;
        }

        const variations = extractRegiondoVariations(detail)
          .map((variation) =>
            normalizeRegiondoCatalogVariation(variation, productBase.regiondoProductId, detail)
          )
          .filter((variation): variation is RegiondoCatalogVariationRecord => Boolean(variation));

        stats.normalizedVariations += variations.length;

        const optionGroups = await mapLimit(
          variations,
          options.variationSyncConcurrency,
          async (variation) => enrichVariationOptions(variation, options, stats, errors)
        );

        const product = {
          ...productBase,
          options: optionGroups.flat(),
          variations
        } satisfies RegiondoCatalogProductRecord;

        stats.normalizedOptions += product.options.length;
        stats.normalizedProducts += 1;
        return product;
      } catch (error) {
        stats.productDetailErrors += 1;
        errors.push({
          message: error instanceof Error ? error.message : 'Unknown Regiondo product detail error.',
          productId: productSummary.product_id,
          stage: 'product_detail'
        });

        if (error instanceof RegiondoApiError) {
          return null;
        }

        return null;
      }
    }
  );

  return {
    errors,
    products: products.filter((product): product is RegiondoCatalogProductRecord => Boolean(product)),
    stats
  };
}
