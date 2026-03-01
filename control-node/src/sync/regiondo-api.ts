import { config } from "../config.js";
import { buildRegionalHeaders } from "./regiondo-auth.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function regiondoGet<T = unknown>(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(endpoint, config.regiondo.baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    queryParams[k] = v;
  });

  const headers = buildRegionalHeaders(queryParams);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: headers as unknown as HeadersInit,
      });

      if (response.status === 429) {
        const retryAfter = parseInt(
          response.headers.get("Retry-After") ?? "5",
          10
        );
        console.warn(
          `[Regiondo] Rate limited. Waiting ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`
        );
        await sleep(retryAfter * 1_000);
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Regiondo API ${response.status}: ${await response.text()}`
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[Regiondo] Request failed (attempt ${attempt}/${MAX_RETRIES}):`,
        lastError.message
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error("Regiondo request failed after retries");
}

export async function fetchCustomers(
  params: Record<string, string> = {}
): Promise<unknown[]> {
  const data = await regiondoGet<{ data: unknown[] }>("customers", params);
  return data.data ?? [];
}

export async function fetchProducts(
  params: Record<string, string> = {}
): Promise<unknown[]> {
  const data = await regiondoGet<{ data: unknown[] }>("products", params);
  return data.data ?? [];
}

export async function fetchBookings(
  params: Record<string, string> = {}
): Promise<unknown[]> {
  const data = await regiondoGet<{ data: unknown[] }>("bookings", params);
  return data.data ?? [];
}
