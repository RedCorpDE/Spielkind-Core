import { appConfig } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ZodError, type ZodType } from 'zod';
import { signRegiondoRequest } from './regiondo.auth.js';
import { RegiondoCatalogSyncError } from './regiondo-catalog.errors.js';
import {
  regiondoCatalogProductsSchema,
  regiondoLocationSchema,
  regiondoLocationsSchema,
  regiondoPurchaseDataSchema,
  regiondoSupplierBookingsSchema,
  type RegiondoCatalogProduct,
  type RegiondoLocation,
  type RegiondoLocationType,
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

const REGIONDO_OBJECT_ENVELOPE_KEYS = [
  'data',
  'item',
  'result',
  'product',
  'full_purchase_data',
  'fullPurchaseData',
  'purchase_data',
  'purchaseData',
  'purchase',
  'order',
  'booking',
  'payload'
];

interface RegiondoRequestOptions {
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT';
  params?: Record<string, string>;
  body?: unknown;
  maxRetries?: number;
  timeoutMs?: number;
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

export interface RegiondoUpdateBookingInput {
  bookingKey: string;
  orderNumber?: string | null;
  contactData?: Partial<RegiondoCheckoutContactData>;
  startsAt?: string;
  endsAt?: string;
  guestCount?: number;
  locationId?: string | null;
  items?: RegiondoCheckoutCartItem[];
  payment?: {
    amountPaid?: number;
    amountToPay?: number;
    paymentMethod?: string | null;
  };
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

export interface RegiondoListLocationsInput {
  limit?: number;
  offset?: number;
  locationType?: RegiondoLocationType;
  isGeneral?: 0 | 1;
  countryCode?: string;
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
  purchaseHydrationMaxAttempts: number;
  purchaseHydrationRetryBaseDelayMs: number;
  purchaseHydrationTimeoutMs: number;
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

export class RegiondoLocationValidationError extends RegiondoApiError {
  constructor(message: string, cause?: unknown) {
    super(message, 400);
    this.name = 'RegiondoLocationValidationError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

const REGIONDO_BOOKING_UPDATE_UNSUPPORTED_MESSAGE =
  'Regiondo does not allow this booking to be edited through the supplier API. No changes were saved. Update the booking in Regiondo, then synchronize it here.';

export class RegiondoBookingUpdateUnsupportedError extends RegiondoApiError {
  readonly retryable = false;

  constructor(cause?: unknown) {
    super(REGIONDO_BOOKING_UPDATE_UNSUPPORTED_MESSAGE, 404);
    this.name = 'RegiondoBookingUpdateUnsupportedError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export type RegiondoPurchaseRecoveryReason = 'post_outcome_unknown' | 'snapshot_unavailable';

interface RegiondoPurchaseRecoveryRequiredErrorInput {
  reason: RegiondoPurchaseRecoveryReason;
  subId?: string;
  orderNumber?: string | null;
  orderId?: string | null;
  attemptCount?: number;
  upstreamStatus?: number;
  cause?: unknown;
}

const REGIONDO_PURCHASE_RECOVERY_MESSAGE =
  'The Regiondo purchase may already exist. Do not submit it again until the existing attempt is reconciled.';

export class RegiondoPurchaseRecoveryRequiredError extends RegiondoApiError {
  readonly retryable = false;
  readonly reason: RegiondoPurchaseRecoveryReason;
  readonly subId: string | null;
  readonly orderNumber: string | null;
  readonly orderId: string | null;
  readonly attemptCount: number | null;
  readonly upstreamStatus: number | null;

  constructor(input: RegiondoPurchaseRecoveryRequiredErrorInput) {
    super(REGIONDO_PURCHASE_RECOVERY_MESSAGE, 502);
    this.name = 'RegiondoPurchaseRecoveryRequiredError';
    this.reason = input.reason;
    this.subId = input.subId?.trim() || null;
    this.orderNumber = input.orderNumber?.trim() || null;
    this.orderId = input.orderId?.trim() || null;
    this.attemptCount = input.attemptCount ?? null;
    this.upstreamStatus = input.upstreamStatus ?? null;

    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
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

function tryParseJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return {
      parsed: true,
      value: JSON.parse(value)
    };
  } catch {
    return { parsed: false };
  }
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

function collectRegiondoObjectPayloadCandidates(
  value: unknown,
  depth = 0,
  visited: WeakSet<object> = new WeakSet()
): unknown[] {
  const candidates = [value];

  if (typeof value === 'string') {
    const parsedJson = tryParseJson(value);
    if (parsedJson.parsed && parsedJson.value !== value) {
      candidates.push(...collectRegiondoObjectPayloadCandidates(parsedJson.value, depth + 1, visited));
    }

    return candidates;
  }

  if (depth >= 5 || value === null || typeof value !== 'object') {
    return candidates;
  }

  if (visited.has(value)) {
    return candidates;
  }
  visited.add(value);

  const record = value as Record<string, unknown>;
  for (const key of REGIONDO_OBJECT_ENVELOPE_KEYS) {
    if (!(key in record) || record[key] === undefined) {
      continue;
    }

    for (const candidate of collectRegiondoObjectPayloadCandidates(record[key], depth + 1, visited)) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function parseRegiondoPurchasePayload(payload: unknown): RegiondoPurchaseData {
  let parsedPurchaseError: ZodError | null = null;

  for (const candidate of collectRegiondoObjectPayloadCandidates(payload)) {
    const parsedPurchase = regiondoPurchaseDataSchema.safeParse(candidate);
    if (parsedPurchase.success) {
      return parsedPurchase.data;
    }

    if (parsedPurchaseError === null || (candidate !== null && typeof candidate === 'object')) {
      parsedPurchaseError = parsedPurchase.error;
    }
  }

  throw new RegiondoPayloadError(
    'Regiondo purchase response payload did not match the expected shape.',
    formatZodErrorDetails(parsedPurchaseError ?? new ZodError([]))
  );
}

function mapHttpError(status: number, responseBody: string): RegiondoApiError {
  if (status === 429) {
    return new RegiondoRateLimitError(status, responseBody);
  }

  if (status === 401 || status === 403) {
    return new RegiondoAuthError(status, responseBody);
  }

  if (status === 408 || status === 425 || status >= 500) {
    return new RegiondoTransientError(status, responseBody);
  }

  return new RegiondoApiError(`Regiondo request failed with status ${status}`, status, responseBody);
}

function stringifyRegiondoIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return null;
}

function extractNestedRegiondoIdentifier(
  value: unknown,
  preferredKeys: string[],
  depth = 0
): string | null {
  const directIdentifier = stringifyRegiondoIdentifier(value);
  if (directIdentifier) {
    return directIdentifier;
  }

  if (depth >= 4 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const identifier = extractNestedRegiondoIdentifier(entry, preferredKeys, depth + 1);
      if (identifier) {
        return identifier;
      }
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of preferredKeys) {
    if (!(key in record)) {
      continue;
    }

    const identifier = extractNestedRegiondoIdentifier(record[key], preferredKeys, depth + 1);
    if (identifier) {
      return identifier;
    }
  }

  const prefersNumber = preferredKeys.some((key) => key.toLowerCase().includes('number'));
  const fallbackKeys = prefersNumber ? ['number', 'value', 'id'] : ['id', 'value', 'number'];

  for (const fallbackKey of fallbackKeys) {
    if (!(fallbackKey in record)) {
      continue;
    }

    const identifier = extractNestedRegiondoIdentifier(record[fallbackKey], preferredKeys, depth + 1);
    if (identifier) {
      return identifier;
    }
  }

  return null;
}

function extractFirstNestedRegiondoIdentifier(value: unknown, preferredKeys: string[]): string | null {
  for (const candidate of collectRegiondoObjectPayloadCandidates(value)) {
    if (candidate === null || typeof candidate !== 'object') {
      continue;
    }

    const identifier = extractNestedRegiondoIdentifier(candidate, preferredKeys);
    if (identifier) {
      return identifier;
    }
  }

  return null;
}

export function isRetryableRegiondoError(error: unknown): boolean {
  return (
    error instanceof RegiondoRateLimitError ||
    error instanceof RegiondoTransientError ||
    error instanceof RegiondoAuthError ||
    (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError))
  );
}

function isRetryableRegiondoRequestError(error: unknown): boolean {
  return (
    error instanceof RegiondoRateLimitError ||
    error instanceof RegiondoTransientError ||
    (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError))
  );
}

function isRetryablePurchaseHydrationError(error: unknown): boolean {
  return error instanceof RegiondoPayloadError || isRetryableRegiondoRequestError(error);
}

function isAmbiguousPurchaseSubmissionError(error: unknown): boolean {
  return (
    error instanceof RegiondoTransientError ||
    error instanceof SyntaxError ||
    (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError))
  );
}

function getRegiondoUpstreamStatus(error: unknown): number | undefined {
  if (error instanceof RegiondoApiError && !(error instanceof RegiondoPayloadError)) {
    return error.status;
  }

  return undefined;
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
  private readonly purchaseHydrationMaxAttempts: number;
  private readonly purchaseHydrationRetryBaseDelayMs: number;
  private readonly purchaseHydrationTimeoutMs: number;
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
    this.purchaseHydrationMaxAttempts =
      options.purchaseHydrationMaxAttempts ?? appConfig.REGIONDO_PURCHASE_HYDRATION_MAX_ATTEMPTS;
    this.purchaseHydrationRetryBaseDelayMs =
      options.purchaseHydrationRetryBaseDelayMs ?? appConfig.REGIONDO_PURCHASE_HYDRATION_RETRY_BASE_DELAY_MS;
    this.purchaseHydrationTimeoutMs =
      options.purchaseHydrationTimeoutMs ?? appConfig.REGIONDO_PURCHASE_HYDRATION_TIMEOUT_MS;
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
    const maxRetries = options.maxRetries ?? (method === 'GET' ? this.maxRetries : 0);
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? this.requestTimeoutMs));
    const queryParams = this.buildQueryParams(options.params ?? {});
    const url = new URL(pathname.replace(/^\//, ''), this.baseUrl);
    url.search = queryParams.toString();

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
          signal: AbortSignal.timeout(timeoutMs)
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
        const parsedJson = tryParseJson(responseBody);
        if (contentType.includes('application/json')) {
          if (!parsedJson.parsed) {
            throw new SyntaxError('Regiondo returned invalid JSON with an application/json content type.');
          }

          return parsedJson.value as T;
        }

        if (parsedJson.parsed) {
          return parsedJson.value as T;
        }

        return responseBody as T;
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableRegiondoRequestError(error)) {
          throw error;
        }

        const delayMs = getRegiondoRetryDelayMs(attempt, this.retryBaseDelayMs);
        logger.warn(
          {
            event: 'regiondo_request_retry_scheduled',
            method,
            pathname,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            delayMs,
            errorName: error instanceof Error ? error.name : typeof error,
            status: error instanceof RegiondoApiError ? error.status : undefined
          },
          'Regiondo request retry scheduled.'
        );
        await this.sleepImplementation(delayMs);
      }
    }

    throw new RegiondoApiError(`Regiondo request failed without a response for ${pathname}`);
  }

  async getCollection<T>(
    pathname: string,
    params: Record<string, string> = {},
    requestOptions: Pick<RegiondoRequestOptions, 'maxRetries' | 'timeoutMs'> = {}
  ): Promise<T[]> {
    const body = await this.requestJson<RegiondoCollectionResponse<T>>(pathname, { ...requestOptions, params });
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

  private createPurchaseRecoveryRequiredError(input: RegiondoPurchaseRecoveryRequiredErrorInput) {
    const error = new RegiondoPurchaseRecoveryRequiredError(input);

    logger.error(
      {
        event: 'regiondo_purchase_reconciliation_required',
        reason: error.reason,
        subId: error.subId,
        orderNumber: error.orderNumber,
        orderId: error.orderId,
        attemptCount: error.attemptCount,
        upstreamStatus: error.upstreamStatus,
        causeName: input.cause instanceof Error ? input.cause.name : undefined
      },
      error.message
    );

    return error;
  }

  private async pollPurchaseOrderSnapshot(input: {
    orderNumber?: string | null;
    orderId?: string | null;
    subId?: string;
  }): Promise<RegiondoPurchaseData> {
    const startedAt = Date.now();
    const deadline = startedAt + this.purchaseHydrationTimeoutMs;
    let orderNumber = input.orderNumber ?? null;
    let lastError: unknown = null;
    let completedAttempts = 0;

    for (let attempt = 1; attempt <= this.purchaseHydrationMaxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      completedAttempts = attempt;

      try {
        if (!orderNumber && input.orderId) {
          const supplierBookings = await this.listSupplierBookings(
            {
              limit: 250,
              orderIds: [input.orderId]
            },
            {
              maxRetries: 0,
              timeoutMs: Math.min(this.requestTimeoutMs, remainingMs)
            }
          );
          orderNumber =
            supplierBookings
              .map((booking) => stringifyRegiondoIdentifier(booking.order_number))
              .find((value): value is string => Boolean(value)) ?? null;

          if (!orderNumber) {
            throw new RegiondoTransientError(
              503,
              `Regiondo has not exposed an order number for order id ${input.orderId} yet.`
            );
          }
        }

        if (!orderNumber) {
          break;
        }

        const purchaseRequestRemainingMs = deadline - Date.now();
        if (purchaseRequestRemainingMs <= 0) {
          throw new RegiondoTransientError(503, 'Regiondo purchase hydration deadline was reached.');
        }

        const purchaseDataRaw = await this.requestJson<RegiondoObjectResponse<unknown> | unknown>(
          '/checkout/purchase',
          {
            maxRetries: 0,
            params: {
              order_number: orderNumber
            },
            timeoutMs: Math.min(this.requestTimeoutMs, purchaseRequestRemainingMs)
          }
        );
        const purchaseData = parseRegiondoPurchasePayload(purchaseDataRaw);

        logger.info(
          {
            event: 'regiondo_purchase_snapshot_hydrated',
            subId: input.subId,
            orderId: input.orderId,
            orderNumber,
            attempt,
            elapsedMs: Date.now() - startedAt
          },
          'Regiondo purchase snapshot hydrated.'
        );

        return purchaseData;
      } catch (error) {
        if (!isRetryablePurchaseHydrationError(error)) {
          throw error;
        }

        lastError = error;
        const delayMs = getRegiondoRetryDelayMs(attempt - 1, this.purchaseHydrationRetryBaseDelayMs);
        const remainingAfterAttemptMs = deadline - Date.now();
        if (attempt >= this.purchaseHydrationMaxAttempts || delayMs >= remainingAfterAttemptMs) {
          break;
        }

        logger.warn(
          {
            event: 'regiondo_purchase_snapshot_poll_retry',
            subId: input.subId,
            orderId: input.orderId,
            orderNumber,
            attempt,
            maxAttempts: this.purchaseHydrationMaxAttempts,
            delayMs,
            elapsedMs: Date.now() - startedAt,
            errorName: error instanceof Error ? error.name : typeof error,
            status: error instanceof RegiondoApiError ? error.status : undefined
          },
          'Regiondo purchase snapshot is not ready; retrying.'
        );
        await this.sleepImplementation(delayMs);
      }
    }

    throw this.createPurchaseRecoveryRequiredError({
      reason: 'snapshot_unavailable',
      subId: input.subId,
      orderNumber,
      orderId: input.orderId,
      attemptCount: completedAttempts,
      upstreamStatus: getRegiondoUpstreamStatus(lastError),
      cause: lastError
    });
  }

  private async resolvePurchaseOrderSnapshot(
    body: unknown,
    context: { subId?: string } = {}
  ): Promise<RegiondoPurchaseData> {
    let initialPayloadError: RegiondoPayloadError;

    try {
      return parseRegiondoPurchasePayload(body);
    } catch (error) {
      if (!(error instanceof RegiondoPayloadError)) {
        throw error;
      }
      initialPayloadError = error;
    }

    const orderNumber = extractFirstNestedRegiondoIdentifier(body, ['order_number', 'orderNumber', 'order_no', 'orderNo']);
    const orderId = extractFirstNestedRegiondoIdentifier(body, ['order_id', 'orderId']);
    if (orderNumber || orderId) {
      return this.pollPurchaseOrderSnapshot({
        subId: context.subId,
        orderNumber,
        orderId
      });
    }

    throw this.createPurchaseRecoveryRequiredError({
      reason: 'snapshot_unavailable',
      subId: context.subId,
      attemptCount: 0,
      cause: initialPayloadError
    });
  }

  async getObject<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const body = await this.requestJson<RegiondoObjectResponse<T> | T>(pathname, { params });
    return this.unwrapObjectResponse(body);
  }

  async getLocations(input: RegiondoListLocationsInput = {}): Promise<RegiondoLocation[]> {
    const requestedLimit = input.limit ?? 250;
    const requestedOffset = input.offset ?? 0;
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
      throw new RegiondoLocationValidationError('Regiondo location list limit must be a positive integer.');
    }
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
      throw new RegiondoLocationValidationError('Regiondo location list offset must be a non-negative integer.');
    }

    const rawLocations = await this.getCollection<unknown>('/locations', {
      limit: `${Math.min(requestedLimit, 250)}`,
      ...(requestedOffset > 0 ? { offset: `${requestedOffset}` } : {}),
      ...(input.locationType ? { location_type: input.locationType } : {}),
      ...(input.isGeneral !== undefined ? { is_general: `${input.isGeneral}` } : {}),
      ...(input.countryCode?.trim() ? { country_code: input.countryCode.trim() } : {})
    });

    return parseRegiondoPayload(regiondoLocationsSchema, rawLocations, 'locations response');
  }

  async getLocation(locationId: number): Promise<RegiondoLocation> {
    if (!Number.isInteger(locationId) || locationId <= 0) {
      throw new RegiondoLocationValidationError('Regiondo location ID must be a positive integer.');
    }

    try {
      const rawLocation = await this.getObject<unknown>(`/locations/${locationId}`);
      return parseRegiondoPayload(regiondoLocationSchema, rawLocation, 'location response');
    } catch (error) {
      if (error instanceof RegiondoApiError && error.status === 404) {
        throw new RegiondoLocationValidationError(`Regiondo location ID ${locationId} was not found.`, error);
      }
      throw error;
    }
  }

  async validateLocation(
    locationId: number,
    expectedType?: RegiondoLocationType
  ): Promise<RegiondoLocation> {
    const location = await this.getLocation(locationId);
    if (expectedType && location.location_type !== expectedType) {
      throw new RegiondoLocationValidationError(
        `Regiondo location ID ${locationId} is a ${location.location_type}, not a ${expectedType}.`
      );
    }
    return location;
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

  async listSupplierBookings(
    input: RegiondoListSupplierBookingsInput = {},
    requestOptions: Pick<RegiondoRequestOptions, 'maxRetries' | 'timeoutMs'> = {}
  ): Promise<RegiondoSupplierBooking[]> {
    const supplierBookingsRaw = await this.getCollection<RegiondoSupplierBooking>(
      '/supplier/bookings',
      {
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
      },
      requestOptions
    );

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
    const purchaseDataRaw = await this.requestJson<RegiondoObjectResponse<unknown> | unknown>('/checkout/purchase', {
      params: {
        order_number: orderNumber
      }
    });

    return {
      supplierBookings,
      purchaseData: parseRegiondoPurchasePayload(purchaseDataRaw)
    };
  }

  async purchaseOrder(input: RegiondoPurchaseOrderInput): Promise<RegiondoPurchaseData> {
    let purchaseDataRaw: RegiondoObjectResponse<unknown> | unknown;

    try {
      purchaseDataRaw = await this.requestJson<RegiondoObjectResponse<unknown> | unknown>('/checkout/purchase', {
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
        maxRetries: 0,
        method: 'POST',
        params: {
          currency: this.currency,
          store_locale: input.storeLocale ?? this.language
        }
      });
    } catch (error) {
      if (!isAmbiguousPurchaseSubmissionError(error)) {
        throw error;
      }

      throw this.createPurchaseRecoveryRequiredError({
        reason: 'post_outcome_unknown',
        subId: input.subId,
        attemptCount: 1,
        upstreamStatus: getRegiondoUpstreamStatus(error),
        cause: error
      });
    }

    return this.resolvePurchaseOrderSnapshot(purchaseDataRaw, { subId: input.subId });
  }

  async updateBooking(input: RegiondoUpdateBookingInput): Promise<unknown> {
    const body = {
      booking_key: input.bookingKey,
      ...(input.orderNumber ? { order_number: input.orderNumber } : {}),
      ...(input.contactData ? { contact_data: input.contactData } : {}),
      ...(input.startsAt ? { date_time: input.startsAt, dt_from: input.startsAt } : {}),
      ...(input.endsAt ? { dt_to: input.endsAt } : {}),
      ...(input.guestCount !== undefined ? { guest_count: input.guestCount } : {}),
      ...(input.locationId ? { location_id: input.locationId } : {}),
      ...(input.items ? { items: input.items } : {}),
      ...(input.payment
        ? {
            payment: {
              ...(input.payment.amountPaid !== undefined ? { amount_paid: input.payment.amountPaid } : {}),
              ...(input.payment.amountToPay !== undefined ? { amount_to_pay: input.payment.amountToPay } : {}),
              ...(input.payment.paymentMethod !== undefined ? { payment_method: input.payment.paymentMethod } : {})
            }
          }
        : {})
    };

    try {
      return await this.requestJson<unknown>(`/supplier/bookings/${encodeURIComponent(input.bookingKey)}`, {
        body,
        method: 'PUT',
        params: {
          ...(input.orderNumber ? { order_number: input.orderNumber } : {}),
          store_locale: this.language
        }
      });
    } catch (error) {
      // Regiondo documents supplier bookings as a read API. Some accounts have
      // historically exposed a private update operation, while others answer
      // with 404 for the operation itself. This is not a location-mapping error
      // and retrying the same ambiguous write is unsafe.
      if (error instanceof RegiondoApiError && error.status === 404) {
        throw new RegiondoBookingUpdateUnsupportedError(error);
      }
      throw error;
    }
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
