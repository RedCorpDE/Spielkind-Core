import { query } from "../db/client.js";
import { config } from "../config.js";
import {
    fetchProductList,
    fetchProductDetail,
    fetchAvailOptions,
    extractOptionsList,
} from "./regiondo-api.js";
import {
    mapVariation,
    mapOption,
    pickSlotFromVariationRaw,
    toCleanNumber,
    type VariationUpsert,
    type OptionUpsert,
} from "./mappers.js";

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;

    async function runner() {
        while (idx < items.length) {
            const current = idx++;
            results[current] = await worker(items[current], current);
        }
    }

    const runners: Promise<void>[] = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) runners.push(runner());
    await Promise.all(runners);
    return results;
}

// ─── DB upserts ───────────────────────────────────────────────────────────────

async function upsertProductRecord(
    productId: number,
    title: string,
    raw: unknown
): Promise<void> {
    await query(
        `INSERT INTO products (regiondo_product_id, title, description, base_amount, regiondo_raw)
     VALUES ($1, $2, NULL, 0, $3)
     ON CONFLICT (regiondo_product_id) DO UPDATE SET
       title        = EXCLUDED.title,
       regiondo_raw = EXCLUDED.regiondo_raw`,
        [String(productId), title, JSON.stringify(raw)]
    );
}

async function upsertVariationRecord(v: VariationUpsert): Promise<void> {
    await query(
        `INSERT INTO variations (variation_id, product_id, title, regiondo_raw)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (variation_id) DO UPDATE SET
       product_id   = EXCLUDED.product_id,
       title        = EXCLUDED.title,
       regiondo_raw = EXCLUDED.regiondo_raw`,
        [v.variation_id, v.product_id, v.title, JSON.stringify(v.regiondo_raw)]
    );
}

async function upsertOptionRecord(o: OptionUpsert): Promise<void> {
    await query(
        `INSERT INTO options (option_id, product_id, variation_id, title, regiondo_raw)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (option_id) DO UPDATE SET
       product_id   = EXCLUDED.product_id,
       variation_id = EXCLUDED.variation_id,
       title        = EXCLUDED.title,
       regiondo_raw = EXCLUDED.regiondo_raw`,
        [o.option_id, o.product_id, o.variation_id, o.title, JSON.stringify(o.regiondo_raw)]
    );
}

// ─── Options fetch for a single variation ────────────────────────────────────

/**
 * Fetches availoptions for a variation using the first available slot.
 * Tries timeShort ("HH:MM") first, falls back to timeFull ("HH:MM:SS") on failure,
 * mirroring the original JS behaviour.
 */
async function fetchOptionsForVariation(
    variationId: number,
    variationRaw: unknown
): Promise<unknown[]> {
    const slot = pickSlotFromVariationRaw(variationRaw);
    if (!slot) return [];

    let resp = await fetchAvailOptions(variationId, slot.date, slot.timeShort);

    // Fallback: try full time string if short form returned nothing
    if (!resp && slot.timeFull !== slot.timeShort) {
        resp = await fetchAvailOptions(variationId, slot.date, slot.timeFull);
    }

    return extractOptionsList(resp);
}

// ─── One page of products ─────────────────────────────────────────────────────

interface PageStats {
    products: number;
    variations: number;
    options: number;
}

async function processProductPage(productIds: number[]): Promise<PageStats> {
    const stats: PageStats = { products: 0, variations: 0, options: 0 };

    // 1. Fetch full product details concurrently
    const fullProducts = await runWithConcurrency(
        productIds,
        config.regiondo.concurrencyProducts,
        async (productId) => {
            const prod = await fetchProductDetail(productId);
            return { productId, prod };
        }
    );

    // 2. Collect product + variation records
    const variationRecords: VariationUpsert[] = [];

    for (const { productId, prod } of fullProducts) {
        if (!prod) continue;

        const title = String(prod.name ?? prod.title ?? `Product ${productId}`);
        await upsertProductRecord(productId, title, prod);
        stats.products++;

        const variations = Array.isArray(prod.variations) ? prod.variations : [];
        for (const v of variations) {
            if (!v || typeof v !== "object") continue;
            const variationId = toCleanNumber(
                (v as Record<string, unknown>).variation_id ??
                (v as Record<string, unknown>).id ??
                (v as Record<string, unknown>).variationId
            );
            if (!Number.isFinite(variationId) || variationId === null) continue;

            const mapped = mapVariation(v as Record<string, unknown>, productId);
            await upsertVariationRecord(mapped);
            variationRecords.push(mapped);
            stats.variations++;
        }
    }

    // 3. Deduplicate variations (same variation can appear across products in a page)
    const uniqueVariations = Array.from(
        new Map(variationRecords.map((v) => [v.variation_id, v])).values()
    );

    // 4. Fetch options for each variation concurrently, collect into a dedup map
    const optionMap = new Map<number, OptionUpsert>();

    await runWithConcurrency(
        uniqueVariations,
        config.regiondo.concurrencyVariations,
        async (v) => {
            const rawOptions = await fetchOptionsForVariation(v.variation_id, v.regiondo_raw);
            for (const o of rawOptions) {
                if (!o || typeof o !== "object") continue;
                const optionId = toCleanNumber(
                    (o as Record<string, unknown>).option_id ??
                    (o as Record<string, unknown>).id ??
                    (o as Record<string, unknown>).optionId
                );
                if (!Number.isFinite(optionId) || optionId === null) continue;
                optionMap.set(
                    optionId,
                    mapOption(o as Record<string, unknown>, v.product_id, v.variation_id)
                );
            }
        }
    );

    // 5. Upsert options
    for (const option of optionMap.values()) {
        await upsertOptionRecord(option);
        stats.options++;
    }

    return stats;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export interface ProductSyncResult {
    pagesProcessed: number;
    productsUpserted: number;
    variationsUpserted: number;
    optionsUpserted: number;
}

export async function syncProducts(): Promise<ProductSyncResult> {
    const result: ProductSyncResult = {
        pagesProcessed: 0,
        productsUpserted: 0,
        variationsUpserted: 0,
        optionsUpserted: 0,
    };

    let offset = 0;
    const { pageLimit, maxPages } = config.regiondo;

    while (result.pagesProcessed < maxPages) {
        console.log(`[ProductSync] Fetching page ${result.pagesProcessed + 1} (offset ${offset})`);

        const list = await fetchProductList({
            limit: String(pageLimit),
            offset: String(offset),
            store_locale: config.regiondo.language,
        });

        if (list.length === 0) {
            console.log("[ProductSync] No more products — done.");
            break;
        }

        // Extract numeric product IDs from the summary list
        const productIds = list
            .map((p) => {
                if (!p || typeof p !== "object") return null;
                return toCleanNumber(
                    (p as Record<string, unknown>).product_id ??
                    (p as Record<string, unknown>).id
                );
            })
            .filter((id): id is number => Number.isFinite(id as number));

        const pageStats = await processProductPage(productIds);

        result.pagesProcessed++;
        result.productsUpserted += pageStats.products;
        result.variationsUpserted += pageStats.variations;
        result.optionsUpserted += pageStats.options;
        offset += list.length;

        console.log(
            `[ProductSync] Page ${result.pagesProcessed}: ` +
            `${pageStats.products} products, ${pageStats.variations} variations, ${pageStats.options} options`
        );

        // Stop early if the page was smaller than the limit (last page)
        if (list.length < pageLimit) break;
    }

    console.log(
        `[ProductSync] Complete — ` +
        `${result.productsUpserted} products, ` +
        `${result.variationsUpserted} variations, ` +
        `${result.optionsUpserted} options ` +
        `across ${result.pagesProcessed} page(s)`
    );

    return result;
}