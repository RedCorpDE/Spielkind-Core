import { appConfig } from '../../config/env.js';
import { ZodError, type ZodType } from 'zod';
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
  full_purchase_data?: T;
  item?: T;
  product?: T;
  result?: T;
};

interface RegiondoRequestOptions {
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT';
  params?: Record<string, string>;
  body?: unknown;
}

export interface RegiondoCheckoutCartItem {
  product_id: number | string;
  qty: number;
  date_time?: string;
  external_item_id?: string;
  option_id?: number | string;
  reservation_code?: string;
  value?: number | string | null;
  [key: string]: unknown;
}

export interface RegiondoCheckoutContactData {
  email: string;
  firstname: string;
  lastname: string;
  telephone?: string;
  [key: string]: unknown;
}

export interface RegiondoPurchaseOrderInput {
  attendeeData?: unknown[];
  buyerData?: unknown[];
  comment?: string;
  contactData: RegiondoCheckoutContactData;
  items: RegiondoCheckoutCartItem[];
  sendTicketsToCustomer?: boolean;
  storeLocale?: string;
  subId?: string;
  syncTicketsProcessing?: boolean;
}

export interface RegiondoListSupplierBookingsInput {
  bookingKey?: string;
  dateRange?: string;
  dateRangeBy?: 'date_bought' | 'date_of_event';
  limit?: number;
  offset?: number;
  orderIds?: string[];
  productIds?: string[];
  resourceIds?: string[];
  status?: string;
  type?: string;
}

interface RegiondoClientOptions {
  baseUrl: string;
  catalogPageSize: number;
  publicKey: string;
  secretKey: string;
  language: string;
  currency: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestThrottleMs: number;
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

export class RegiondoPayloadError extends RegiondoApiError {
  constructor(message: string, details: string) {
    super(message, 502, details);
    this.name = 'RegiondoPayloadError';
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function formatZodErrorDetails(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
    .join('; ');
}

function parseRegiondoPayload<T>(schema: ZodType<T, any, any>, payload: unknown, context: string): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  throw new RegiondoPayloadError(
    `Regiondo ${context} payload did not match the expected shape.`,
    formatZodErrorDetails(parsed.error)
  );
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
  private readonly currency: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestThrottleMs: number;
  private readonly supplierId: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleepImplementation: (delayMs: number) => Promise<void>;
  private nextRequestAt = Date.now();

  constructor(options: Partial<RegiondoClientOptions> = {}) {
    const baseUrl = options.baseUrl ?? appConfig.REGIONDO_BASE_URL;
    this.baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.catalogPageSize = options.catalogPageSize ?? DEFAULT_REGIONDO_CATALOG_PAGE_SIZE;
    this.publicKey = options.publicKey ?? appConfig.REGIONDO_PUBLIC_KEY;
    this.secretKey = options.secretKey ?? appConfig.REGIONDO_SECRET_KEY;
    this.language = options.language ?? appConfig.REGIONDO_LANGUAGE;
    this.currency = options.currency ?? appConfig.REGIONDO_CURRENCY;
    this.requestTimeoutMs = options.requestTimeoutMs ?? appConfig.REGIONDO_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? appConfig.REGIONDO_REQUEST_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? appConfig.REGIONDO_REQUEST_RETRY_BASE_DELAY_MS;
    this.requestThrottleMs = options.requestThrottleMs ?? appConfig.REGIONDO_REQUEST_THROTTLE_MS;
    this.supplierId = options.supplierId ?? appConfig.REGIONDO_PRODUCT_SUPPLIER_ID;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleepImplementation = options.sleep ?? sleep;
  }

  private buildQueryParams(params: Record<string, string>): URLSearchParams {
    const queryParams = new URLSearchParams();

    Object.entries(params)
      .filter(([, value]) => value !== '')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .forEach(([key, value]) => {
        queryParams.set(key, value);
      });

    return queryParams;
  }

  private async throttleRequest(): Promise<void> {
    if (this.requestThrottleMs <= 0) {
      return;
    }

    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduledAt + this.requestThrottleMs;
    const delayMs = scheduledAt - now;

    if (delayMs > 0) {
      await this.sleepImplementation(delayMs);
    }
  }

  private async requestJson<T>(pathname: string, options: RegiondoRequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const queryParams = this.buildQueryParams(options.params ?? {});
    const url = new URL(pathname.replace(/^\//, ''), this.baseUrl);
    url.search = queryParams.toString();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.throttleRequest();

        const timestamp = Date.now();
        const hash = signRegiondoRequest({
          timestamp,
          publicKey: this.publicKey,
          secretKey: this.secretKey,
          queryParams
        });

        const response = await this.fetchImplementation(url, {
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          headers: {
            'X-API-ID': this.publicKey,
            'X-API-TIME': `${timestamp}`,
            'X-API-HASH': hash,
            'Accept-Language': this.language,
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          method,
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });

        if (!response.ok) {
          throw mapHttpError(response.status, await response.text());
        }

        if (response.status === 204) {
          return undefined as T;
        }

        const responseBody = await response.text();
        if (!responseBody) {
          return undefined as T;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          return JSON.parse(responseBody) as T;
        }

        return responseBody as T;
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
    const body = await this.requestJson<RegiondoCollectionResponse<T>>(pathname, { params });
    return body.data ?? body.items ?? [];
  }

  private unwrapObjectResponse<T>(body: RegiondoObjectResponse<T> | T): T {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if ('data' in body && body.data !== undefined) {
        return body.data;
      }

      if ('item' in body && body.item !== undefined) {
        return body.item;
      }

      if ('result' in body && body.result !== undefined) {
        return body.result;
      }

      if ('product' in body && body.product !== undefined) {
        return body.product;
      }

      if ('full_purchase_data' in body && body.full_purchase_data !== undefined) {
        return body.full_purchase_data;
      }
    }

    return body as T;
  }

  async getObject<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const body = await this.requestJson<RegiondoObjectResponse<T> | T>(pathname, { params });
    return this.unwrapObjectResponse(body);
  }

  async getCatalogProducts(): Promise<RegiondoCatalogProduct[]> {
    const productsRaw: unknown[] = [];
    let offset = 0;

    while (true) {
      const response = await this.requestJson<RegiondoCollectionResponse<unknown>>('/products', {
        params: {
          currency: this.currency,
          limit: `${this.catalogPageSize}`,
          ...(offset > 0 ? { offset: `${offset}` } : {}),
          store_locale: this.language,
          supplier_id: this.supplierId
        }
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

  async getProductDetail(productId: string): Promise<unknown> {
    return this.getObject<unknown>(`/products/${encodeURIComponent(productId)}`, {
      currency: this.currency,
      store_locale: this.language
    });
  }

  async getVariationAvailability(input: {
    variationId: string;
    from: string;
    to: string;
  }): Promise<unknown> {
    return this.requestJson<unknown>(`/products/availabilities/${encodeURIComponent(input.variationId)}`, {
      params: {
        dt_from: input.from,
        dt_to: input.to,
        store_locale: this.language
      }
    });
  }

  async getAvailableOptions(input: {
    variationId: string;
    date?: string;
    time?: string;
  }): Promise<unknown> {
    return this.requestJson<unknown>(`/products/availoptions/${encodeURIComponent(input.variationId)}`, {
      params: {
        ...(input.date ? { date: input.date } : {}),
        ...(input.time ? { time: input.time } : {}),
        store_locale: this.language
      }
    });
  }

  async listSupplierBookings(input: RegiondoListSupplierBookingsInput = {}): Promise<RegiondoSupplierBooking[]> {
    const supplierBookingsRaw = await this.getCollection<RegiondoSupplierBooking>('/supplier/bookings', {
      ...(input.bookingKey ? { booking_key: input.bookingKey } : {}),
      ...(input.dateRange ? { date_range: input.dateRange } : {}),
      ...(input.dateRangeBy ? { date_range_by: input.dateRangeBy } : {}),
      ...(typeof input.limit === 'number' ? { limit: `${input.limit}` } : {}),
      ...(typeof input.offset === 'number' ? { offset: `${input.offset}` } : {}),
      ...(input.orderIds?.length ? { order_ids: input.orderIds.join(',') } : {}),
      ...(input.productIds?.length ? { product_ids: input.productIds.join(',') } : {}),
      ...(input.resourceIds?.length ? { resource_ids: input.resourceIds.join(',') } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.type ? { type: input.type } : {})
    });

    return parseRegiondoPayload(regiondoSupplierBookingsSchema, supplierBookingsRaw, 'supplier bookings response');
  }

  async hydrateBookingOrder(input: {
    bookingKey: string;
    orderNumber?: string | null;
  }): Promise<{ supplierBookings: RegiondoSupplierBooking[]; purchaseData: RegiondoPurchaseData }> {
    const supplierBookings = await this.listSupplierBookings({
      bookingKey: input.bookingKey,
      limit: 250
    });
    if (!supplierBookings.length) {
      throw new RegiondoTransientError(503, `No supplier bookings found for ${input.bookingKey}`);
    }

    const orderNumber = input.orderNumber ?? String(supplierBookings[0].order_number);
    const purchaseDataRaw = await this.getObject<RegiondoPurchaseData>('/checkout/purchase', {
      order_number: orderNumber
    });

    return {
      supplierBookings,
      purchaseData: parseRegiondoPayload(regiondoPurchaseDataSchema, purchaseDataRaw, 'purchase response')
    };
  }

  async purchaseOrder(input: RegiondoPurchaseOrderInput): Promise<RegiondoPurchaseData> {
    const purchaseDataRaw = await this.requestJson<RegiondoObjectResponse<unknown> | unknown>('/checkout/purchase', {
      body: {
        ...(input.attendeeData?.length ? { attendee_data: input.attendeeData } : {}),
        ...(input.buyerData?.length ? { buyer_data: input.buyerData } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        contact_data: input.contactData,
        items: input.items,
        ...(input.sendTicketsToCustomer !== undefined
          ? { send_tickets_to_customer: input.sendTicketsToCustomer }
          : {}),
        ...(input.subId ? { sub_id: input.subId } : {}),
        ...(input.syncTicketsProcessing !== undefined
          ? { sync_tickets_processing: input.syncTicketsProcessing }
          : {})
      },
      method: 'POST',
      params: {
        currency: this.currency,
        store_locale: input.storeLocale ?? this.language
      }
    });

    return parseRegiondoPayload(
      regiondoPurchaseDataSchema,
      this.unwrapObjectResponse(purchaseDataRaw),
      'purchase response'
    );
  }

  async cancelTickets(referenceIds: string[]): Promise<void> {
    if (!referenceIds.length) {
      return;
    }

    await this.requestJson<unknown>('/checkout/cancel', {
      method: 'POST',
      params: {
        reference_ids: referenceIds.join(',')
      }
    });
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
