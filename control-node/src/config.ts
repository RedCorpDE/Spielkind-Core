import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Like optInt, but clamps the result to [min, max].
 * Use for any value that could cause API abuse or system instability if set
 * too low/high — floors and ceilings are enforced in code, not just documented.
 */
function clampedInt(key: string, fallback: number, min: number, max: number): number {
  const n = optInt(key, fallback);
  if (n < min) {
    console.warn(`[Config] ${key}=${n} is below the minimum (${min}), clamping to ${min}`);
    return min;
  }
  if (n > max) {
    console.warn(`[Config] ${key}=${n} exceeds the maximum (${max}), clamping to ${max}`);
    return max;
  }
  return n;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),

  regiondo: {
    publicKey:  requireEnv("REGIONDO_PUBLIC_KEY"),
    privateKey: requireEnv("REGIONDO_PRIVATE_KEY"),
    baseUrl:    process.env.REGIONDO_BASE_URL ?? "https://api.regiondo.com/v1/",
    language:   process.env.REGIONDO_LANGUAGE ?? "de-DE",
    currency:   process.env.REGIONDO_CURRENCY ?? "EUR",

    // These values are clamped - setting them outside the safe range is silently
    // corrected with a warning, never silently accepted.
    //
    //                              default  min   max
    throttleMs:            clampedInt("REGIONDO_THROTTLE_MS",            200,  100, 2_000),
    concurrencyProducts:   clampedInt("REGIONDO_CONCURRENCY_PRODUCTS",     3,    1,     5),
    concurrencyVariations: clampedInt("REGIONDO_CONCURRENCY_VARIATIONS",   3,    1,     5),
    pageLimit:             clampedInt("REGIONDO_PAGE_LIMIT",              50,    1,   100),
    maxPages:              clampedInt("REGIONDO_MAX_PAGES",              100,    1, 1_000),
  },

  webhook: {
    port: optInt("WEBHOOK_PORT", 3001),
    verifySignature: process.env.WEBHOOK_VERIFY_SIGNATURE !== "false",
  },

  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;