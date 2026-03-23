import { config } from "../config.js";
import { buildRegionalHeaders } from "./regiondo-auth.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

const THROTTLE_FLOOR_MS = 100;

// Shared throttle state — ensures no two requests fire closer than throttleMs apart
let lastRequestAt = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Core signed GET ─────────────────────────────────────────────────────────

export async function regiondoGet<T = unknown>(
    endpoint: string,
    params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(endpoint, config.regiondo.baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, v);
    }
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });

  const headers = buildRegionalHeaders(queryParams);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Throttle — respect minimum gap between requests
    const effectiveThrottle = Math.max(config.regiondo.throttleMs, THROTTLE_FLOOR_MS);
    const wait = Math.max(0, effectiveThrottle - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: headers as unknown as HeadersInit,
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") ?? "5", 10);
        console.warn(`[Regiondo] Rate limited. Waiting ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(retryAfter * 1_000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Regiondo API ${response.status}: ${await response.text()}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Regiondo] Request failed (attempt ${attempt}/${MAX_RETRIES}):`, lastError.message);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError ?? new Error("Regiondo request failed after retries");
}

// ─── Bookings / Customers (existing) ────────────────────────────────────────

export async function fetchCustomers(
    params: Record<string, string> = {}
): Promise<unknown[]> {
  const data = await regiondoGet<{ data: unknown[] }>("customers", params);
  return data.data ?? [];
}

export async function fetchBookings(
    params: Record<string, string> = {}
): Promise<unknown[]> {
  const data = await regiondoGet<{ data: unknown[] }>("supplier/bookings", params);
  return data.data ?? [];
}

// ─── Products ────────────────────────────────────────────────────────────────

/**
 * GET /products — paged product list (returns summary objects with product_id).
 */
export async function fetchProductList(params: Record<string, string> = {}): Promise<unknown[]> {
  const resp = await regiondoGet<unknown>("/products", params);
  return normalizeArray(resp);
}

/**
 * GET /products/{productId} — full product detail including variations.
 */
export async function fetchProductDetail(productId: number): Promise<Record<string, unknown> | null> {
  const resp = await regiondoGet<{ data?: unknown }>(`/products/${productId}`, {
    store_locale: config.regiondo.language,
    currency: config.regiondo.currency,
  });
  // Regiondo wraps the full product in .data
  if (resp?.data && typeof resp.data === "object") {
    return resp.data as Record<string, unknown>;
  }
  return null;
}

/**
 * GET /products/availoptions/{variationId} — available options for a slot.
 * Returns null if the endpoint 404s / errors (some variations have no availoptions).
 */
export async function fetchAvailOptions(
    variationId: number,
    date: string,
    time: string
): Promise<unknown> {
  try {
    return await regiondoGet<unknown>(`/products/availoptions/${variationId}`, {
      date,
      time,
      store_locale: config.regiondo.language,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 / 422 are expected for variations with no availability — not worth warning loudly
    if (msg.includes("404") || msg.includes("422")) return null;
    console.warn(`[Regiondo] availoptions/${variationId} failed: ${msg}`);
    return null;
  }
}

// ─── Shared normalizers (used by product-sync) ───────────────────────────────

export function normalizeArray(maybeArrayOrObject: unknown): unknown[] {
  if (Array.isArray(maybeArrayOrObject)) return maybeArrayOrObject;
  if (!maybeArrayOrObject || typeof maybeArrayOrObject !== "object") return [];

  const obj = maybeArrayOrObject as Record<string, unknown>;

  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.options)) return obj.options;
  if (Array.isArray(obj.avail_options)) return obj.avail_options;

  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const d = obj.data as Record<string, unknown>;
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.results)) return d.results;
    if (Array.isArray(d.options)) return d.options;
    if (Array.isArray(d.avail_options)) return d.avail_options;
    if (Array.isArray(d.data)) return d.data;
  }

  return [];
}

function looksLikeOptionObject(o: unknown): boolean {
  return !!(
      o &&
      typeof o === "object" &&
      ((o as Record<string, unknown>).option_id !== undefined ||
          (o as Record<string, unknown>).optionId !== undefined)
  );
}

/**
 * Extracts a flat array of option objects from whatever shape Regiondo returns
 * for /products/availoptions (which varies: dict-keyed map, wrapped array, etc.).
 */
export function extractOptionsList(optionsResp: unknown): unknown[] {
  if (!optionsResp) return [];
  if (Array.isArray(optionsResp)) return optionsResp;
  if (typeof optionsResp !== "object") return [];

  const obj = optionsResp as Record<string, unknown>;

  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const d = obj.data as Record<string, unknown>;

    if (Array.isArray(d.options)) return d.options;
    if (Array.isArray(d.avail_options)) return d.avail_options;
    if (Array.isArray(d.data)) return d.data;

    // Regiondo sometimes returns a dict/map of option objects keyed by id
    const vals = Object.values(d);
    const optionVals = vals.filter(looksLikeOptionObject);
    if (optionVals.length > 0) return optionVals;

    if (looksLikeOptionObject(d)) return [d];
  }

  if (Array.isArray(obj.options)) return obj.options;
  if (Array.isArray(obj.avail_options)) return obj.avail_options;
  if (looksLikeOptionObject(obj)) return [obj];

  return normalizeArray(optionsResp);
}