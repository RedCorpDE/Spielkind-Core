import { appConfig } from '../../config/env.js';
import { signRegiondoRequest } from './regiondo.auth.js';
import { RegiondoCatalogSyncError } from './regiondo-catalog.errors.js';
import {
  regiondoCatalogProductsSchema,
  regiondoPurchaseDataSchema,
  regiondoSupplierBookingsSchema,
  type RegiondoCatalogProduct,
  type RegiondoPurchaseData,
  type RegiondoSupplierBooking
} from './regiondo.types.js';

type RegiondoCollectionResponse<T> = {
  data?: T[];
  items?: T[];
  page?: {
    current?: number | string;
    last?: number | string;
    next?: number | string;
    total_pages?: number | string;
    total_items?: number | string;
    limit?: number | string;
  };
};

type RegiondoObjectResponse<T> = {
  data?: T;
  item?: T;
};

interface RegiondoClientOptions {
  baseUrl: string;
  catalogPageSize: number;
  publicKey: string;
  secretKey: string;
  language: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  supplierId: string;
  fetchImplementation: typeof fetch;
  sleep: (delayMs: number) => Promise<void>;
}

const DEFAULT_REGIONDO_CATALOG_PAGE_SIZE = 250;

export class RegiondoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: string
  ) {
    super(message);
    this.name = 'RegiondoApiError';
  }
}

export class RegiondoRateLimitError extends RegiondoApiError {
  constructor(status: number, responseBody: string) {
    super(`Regiondo rate limit reached: ${status}`, status, responseBody);
    this.name = 'RegiondoRateLimitError';
  }
}

export class RegiondoAuthError extends RegiondoApiError {
  constructor(status: number, responseBody: string) {
    super(`Regiondo authentication failed: ${status}`, status, responseBody);
    this.name = 'RegiondoAuthError';
  }
}

export class RegiondoTransientError extends RegiondoApiError {
  constructor(status: number, responseBody: string) {
    super(`Regiondo transient failure: ${status}`, status, responseBody);
    this.name = 'RegiondoTransientError';
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function mapHttpError(status: number, responseBody: string): RegiondoApiError {
  if (status === 429) {
    return new RegiondoRateLimitError(status, responseBody);
  }

  if (status === 401 || status === 403) {
    return new RegiondoAuthError(status, responseBody);
  }

  if ([408, 500, 502, 503, 504].includes(status)) {
    return new RegiondoTransientError(status, responseBody);
  }

  return new RegiondoApiError(`Regiondo request failed with status ${status}`, status, responseBody);
}

export function isRetryableRegiondoError(error: unknown): boolean {
  return (
    error instanceof RegiondoRateLimitError ||
    error instanceof RegiondoTransientError ||
    error instanceof RegiondoAuthError ||
    (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError))
  );
}

export function getRegiondoRetryDelayMs(attemptNumber: number, baseDelayMs: number): number {
  return Math.min(5_000, baseDelayMs * 2 ** Math.max(0, attemptNumber));
}

export class RegiondoClient {
  private readonly baseUrl: URL;
  private readonly catalogPageSize: number;
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly language: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly supplierId: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleepImplementation: (delayMs: number) => Promise<void>;

  constructor(options: Partial<RegiondoClientOptions> = {}) {
    const baseUrl = options.baseUrl ?? appConfig.REGIONDO_BASE_URL;
    this.baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.catalogPageSize = options.catalogPageSize ?? DEFAULT_REGIONDO_CATALOG_PAGE_SIZE;
    this.publicKey = options.publicKey ?? appConfig.REGIONDO_PUBLIC_KEY;
    this.secretKey = options.secretKey ?? appConfig.REGIONDO_SECRET_KEY;
    this.language = options.language ?? appConfig.REGIONDO_LANGUAGE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? appConfig.REGIONDO_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? appConfig.REGIONDO_REQUEST_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? appConfig.REGIONDO_REQUEST_RETRY_BASE_DELAY_MS;
    this.supplierId = options.supplierId ?? appConfig.REGIONDO_PRODUCT_SUPPLIER_ID;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleepImplementation = options.sleep ?? sleep;
  }

  private async requestJson<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const queryParams = new URLSearchParams(params);
    const url = new URL(pathname.replace(/^\//, ''), this.baseUrl);
    url.search = queryParams.toString();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const hash = signRegiondoRequest({
          timestamp,
          publicKey: this.publicKey,
          secretKey: this.secretKey,
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
          throw mapHttpError(response.status, await response.text());
        }

        return (await response.json()) as T;
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryableRegiondoError(error)) {
          throw error;
        }

        await this.sleepImplementation(getRegiondoRetryDelayMs(attempt, this.retryBaseDelayMs));
      }
    }

    throw new RegiondoApiError(`Regiondo request failed without a response for ${pathname}`);
  }

  async getCollection<T>(pathname: string, params: Record<string, string> = {}): Promise<T[]> {
    const body = await this.requestJson<RegiondoCollectionResponse<T>>(pathname, params);
    return body.data ?? body.items ?? [];
  }

  async getObject<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const body = await this.requestJson<RegiondoObjectResponse<T> | T>(pathname, params);

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

  async getCatalogProducts(): Promise<RegiondoCatalogProduct[]> {
    const productsRaw: unknown[] = [];
    let offset = 0;

    while (true) {
      const response = await this.requestJson<RegiondoCollectionResponse<unknown>>('/products', {
        supplier_id: this.supplierId,
        limit: `${this.catalogPageSize}`,
        ...(offset > 0 ? { offset: `${offset}` } : {})
      });
      const pageItems = response.data ?? response.items ?? [];
      const currentPage = normalizePositiveInteger(response.page?.current);
      const lastPage = normalizePositiveInteger(response.page?.last ?? response.page?.total_pages);
      const pageSize = normalizePositiveInteger(response.page?.limit) ?? this.catalogPageSize;

      productsRaw.push(...pageItems);

      if (pageItems.length === 0) {
        break;
      }

      if (currentPage !== null && lastPage !== null) {
        if (currentPage >= lastPage) {
          break;
        }
      } else if (pageItems.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    const parsed = regiondoCatalogProductsSchema.safeParse(productsRaw);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'catalog'}: ${issue.message}`)
        .join('; ');

      throw new RegiondoCatalogSyncError(
        'Regiondo catalog payload did not match the expected product shape.',
        502,
        details
      );
    }

    return parsed.data;
  }

  async hydrateBookingOrder(input: {
    bookingKey: string;
    orderNumber?: string | null;
  }): Promise<{ supplierBookings: RegiondoSupplierBooking[]; purchaseData: RegiondoPurchaseData }> {
    const supplierBookingsRaw = await this.getCollection<RegiondoSupplierBooking>('/supplier/bookings', {
      booking_key: input.bookingKey,
      limit: '250'
    });

    const supplierBookings = regiondoSupplierBookingsSchema.parse(supplierBookingsRaw);
    if (!supplierBookings.length) {
      throw new RegiondoTransientError(503, `No supplier bookings found for ${input.bookingKey}`);
    }

    const orderNumber = input.orderNumber ?? String(supplierBookings[0].order_number);
    const purchaseDataRaw = await this.getObject<RegiondoPurchaseData>('/checkout/purchase', {
      order_number: orderNumber
    });

    return {
      supplierBookings,
      purchaseData: regiondoPurchaseDataSchema.parse(purchaseDataRaw)
    };
  }
}

export const regiondoClient = new RegiondoClient();

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}
