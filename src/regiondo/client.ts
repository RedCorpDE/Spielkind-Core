import { appConfig } from '../config.js';
import { signRegiondoRequest } from './auth.js';
import type { RegiondoPurchaseData, RegiondoSupplierBooking } from '../sync/types.js';

type RegiondoCollectionResponse<T> = {
  data?: T[];
  items?: T[];
};

type RegiondoObjectResponse<T> = {
  data?: T;
  item?: T;
};

interface RegiondoClientOptions {
  baseUrl: string;
  publicKey: string;
  privateKey: string;
  language: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  fetchImplementation: typeof fetch;
  sleep: (delayMs: number) => Promise<void>;
}

class RegiondoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(`Regiondo request failed ${status}: ${responseBody}`);
    this.name = 'RegiondoHttpError';
  }
}

const RETRYABLE_REGIONDO_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableRegiondoStatus(status: number): boolean {
  return RETRYABLE_REGIONDO_STATUS_CODES.has(status);
}

export function isRetryableRegiondoError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof RegiondoHttpError) {
    return isRetryableRegiondoStatus(error.status);
  }

  return error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError;
}

export function getRegiondoRetryDelayMs(attemptNumber: number, baseDelayMs: number): number {
  return Math.min(5_000, baseDelayMs * 2 ** Math.max(0, attemptNumber));
}

export class RegiondoClient {
  private readonly baseUrl: URL;
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly language: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleepImplementation: (delayMs: number) => Promise<void>;

  constructor(options: Partial<RegiondoClientOptions> = {}) {
    const resolvedBaseUrl = options.baseUrl ?? appConfig.REGIONDO_BASE_URL;

    this.baseUrl = new URL(resolvedBaseUrl.endsWith('/') ? resolvedBaseUrl : `${resolvedBaseUrl}/`);
    this.publicKey = options.publicKey ?? appConfig.REGIONDO_PUBLIC_KEY;
    this.privateKey = options.privateKey ?? appConfig.REGIONDO_PRIVATE_KEY;
    this.language = options.language ?? appConfig.REGIONDO_LANGUAGE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? appConfig.REGIONDO_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? appConfig.REGIONDO_REQUEST_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? appConfig.REGIONDO_REQUEST_RETRY_BASE_DELAY_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleepImplementation = options.sleep ?? sleep;
  }

  private async requestJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const queryParams = new URLSearchParams(params);
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    url.search = queryParams.toString();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const hash = signRegiondoRequest({
          timestamp,
          publicKey: this.publicKey,
          privateKey: this.privateKey,
          queryParams
        });

        const response = await this.fetchImplementation(url, {
          headers: {
            'X-API-ID': this.publicKey,
            'X-API-TIME': `${timestamp}`,
            'X-API-HASH': hash,
            'Accept-Language': this.language,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });

        if (!response.ok) {
          throw new RegiondoHttpError(response.status, await response.text());
        }

        return (await response.json()) as T;
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryableRegiondoError(error)) {
          throw error;
        }

        await this.sleepImplementation(getRegiondoRetryDelayMs(attempt, this.retryBaseDelayMs));
      }
    }

    throw new Error(`Regiondo request failed without returning a response for ${url.pathname}.`);
  }

  async getCollection<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const body = await this.requestJson<RegiondoCollectionResponse<T>>(path, params);
    return body.data ?? body.items ?? [];
  }

  async getObject<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const body = await this.requestJson<RegiondoObjectResponse<T> | T>(path, params);

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if ('data' in body && body.data !== undefined) {
        return body.data;
      }

      if ('item' in body && body.item !== undefined) {
        return body.item;
      }
    }

    return body as T;
  }

  async getSupplierBookings(params: { bookingKey: string; limit?: number }): Promise<RegiondoSupplierBooking[]> {
    return this.getCollection<RegiondoSupplierBooking>('/supplier/bookings', {
      booking_key: params.bookingKey,
      limit: `${params.limit ?? 250}`
    });
  }

  async getPurchaseByOrderNumber(orderNumber: string): Promise<RegiondoPurchaseData> {
    return this.getObject<RegiondoPurchaseData>('/checkout/purchase', { order_number: orderNumber });
  }
}

export const regiondoClient = new RegiondoClient();
