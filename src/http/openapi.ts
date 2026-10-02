const errorCodes = [
  'VALIDATION_ERROR', 'AUTHENTICATION_REQUIRED', 'FORBIDDEN', 'NOT_FOUND',
  'AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_INSUFFICIENT_SCOPE', 'CHECKOUT_TOKEN_INVALID',
  'BOOKING_NOT_FOUND', 'PRODUCT_NOT_FOUND',
  'AVAILABILITY_CHANGED', 'PRICE_CHANGED', 'INVALID_VARIANT', 'INVALID_OPTION',
  'AVAILABILITY_UNAVAILABLE', 'SALES_CLOSED', 'RESOURCE_UNAVAILABLE', 'HOLD_EXPIRED', 'CHECKOUT_EXPIRED',
  'CHECKOUT_ALREADY_COMPLETED', 'INVALID_BOOKING_TRANSITION',
  'INVALID_PAYMENT_TRANSITION', 'PAYMENT_FAILED', 'PAYMENT_REQUIRES_ACTION',
  'PAYMENT_INITIALIZATION_FAILED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED', 'REFUND_FAILED', 'REGIONDO_UNAVAILABLE', 'CONFLICT', 'INTERNAL_ERROR'
] as const;

const schemaContent = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const json = schemaContent({ $ref: '#/components/schemas/GenericObject' });
const errorResponse = {
  description: 'Structured Core error. Legacy admin/client fields remain during migration.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
};
const responses = {
  '400': errorResponse, '401': errorResponse, '403': errorResponse, '404': errorResponse,
  '409': errorResponse, '422': errorResponse, '429': errorResponse, '500': errorResponse
};
const clientSecurity = [{ clientBearer: [] }];
const adminSecurity = [{ adminBearer: [] }];
const webSecurity = [{ wordpressService: [] }];
const uuidSchema = { type: 'string', format: 'uuid' } as const;
const productIdParameter = { name: 'productId', in: 'path', required: true, schema: uuidSchema } as const;
const bookingIdParameter = { name: 'bookingId', in: 'path', required: true, schema: uuidSchema } as const;
const holdIdParameter = { name: 'holdId', in: 'path', required: true, schema: uuidSchema } as const;
const optionalLocationParameter = { name: 'locationId', in: 'query', required: false, schema: uuidSchema } as const;
const requiredLocationParameter = { name: 'locationId', in: 'query', required: true, schema: uuidSchema } as const;
const idempotencyParameter = {
  name: 'x-idempotency-key', in: 'header', required: true,
  description: 'Stable key reused for retries of the same logical operation.',
  schema: { type: 'string', minLength: 1, maxLength: 200 }
} as const;
const webIdempotencyParameter = {
  ...idempotencyParameter, name: 'Idempotency-Key',
  description: 'Stable checkout-attempt key. x-idempotency-key is accepted as an alias.'
} as const;
const checkoutTokenParameter = {
  name: 'x-checkout-token', in: 'header', required: true,
  description: 'Opaque token returned by checkout for polling this booking.',
  schema: { type: 'string', minLength: 1 }
} as const;

function operation(
  summary: string,
  security: Array<Record<string, never[]>>,
  requestSchema?: string,
  responseSchema = 'GenericObject'
) {
  return {
    summary,
    security,
    ...(requestSchema ? {
      requestBody: {
        required: true,
        content: schemaContent({ $ref: `#/components/schemas/${requestSchema}` })
      }
    } : {}),
    responses: {
      '200': {
        description: 'Success',
        content: schemaContent({ $ref: `#/components/schemas/${responseSchema}` })
      },
      ...responses
    }
  };
}

export const coreOpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Spielkind Core API',
    version: '1.0.0-sprint1',
    description: 'Implemented booking, availability, hold, checkout, and booking-operation contracts.'
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Client', description: 'Authenticated Expo client API.' },
    { name: 'Web', description: 'WordPress service façade; the service token stays server-side.' },
    { name: 'Admin', description: 'Authenticated Dashboard API.' }
  ],
  paths: {
    '/api/client/products': {
      get: { ...operation('List bookable products', clientSecurity, undefined, 'CollectionResponse'), tags: ['Client'], parameters: [optionalLocationParameter] }
    },
    '/api/client/products/{productId}': {
      get: { ...operation('Get product contract', clientSecurity), tags: ['Client'], parameters: [productIdParameter, requiredLocationParameter] }
    },
    '/api/client/products/{productId}/availability': {
      post: {
        ...operation('Check authoritative availability', clientSecurity, 'BookingIntent', 'AvailabilityResponse'),
        tags: ['Client'], parameters: [productIdParameter]
      }
    },
    '/api/client/booking-quotes': {
      post: { ...operation('Create authoritative quote', clientSecurity, 'BookingIntent', 'QuoteResponse'), tags: ['Client'] }
    },
    '/api/client/booking-holds': {
      post: {
        ...operation('Create idempotent reservation hold', clientSecurity, 'BookingIntent', 'HoldResponse'),
        tags: ['Client'], parameters: [idempotencyParameter]
      }
    },
    '/api/client/reservation-holds/{holdId}': {
      delete: { ...operation('Release reservation hold', clientSecurity), tags: ['Client'], parameters: [holdIdParameter] }
    },
    '/api/client/bookings': {
      post: {
        ...operation('Create idempotent booking', clientSecurity, 'BookingCreateRequest', 'BookingCreateResponse'),
        tags: ['Client'], parameters: [idempotencyParameter]
      }
    },
    '/api/client/bookings/{bookingId}/checkout': {
      post: {
        ...operation('Start idempotent checkout', clientSecurity, undefined, 'CheckoutResponse'),
        tags: ['Client'], parameters: [bookingIdParameter, idempotencyParameter]
      }
    },
    '/api/client/bookings/{bookingId}/cancel': {
      post: {
        ...operation('Cancel through validated action', clientSecurity),
        tags: ['Client'], parameters: [bookingIdParameter]
      }
    },
    '/api/web/locations': { get: { ...operation('List public locations', webSecurity), tags: ['Web'] } },
    '/api/web/products': {
      get: { ...operation('List public products', webSecurity, undefined, 'CollectionResponse'), tags: ['Web'], parameters: [optionalLocationParameter] }
    },
    '/api/web/products/{productId}/availability': {
      post: {
        ...operation('Check public availability', webSecurity, 'WebAvailabilityRequest', 'AvailabilityResponse'),
        tags: ['Web'], parameters: [productIdParameter]
      }
    },
    '/api/web/booking-quotes': {
      post: { ...operation('Create public quote', webSecurity, 'BookingIntent', 'QuoteResponse'), tags: ['Web'] }
    },
    '/api/web/booking-holds': {
      post: {
        ...operation('Create public hold', webSecurity, 'BookingIntent', 'HoldResponse'),
        tags: ['Web'], parameters: [webIdempotencyParameter]
      }
    },
    '/api/web/checkout': {
      post: {
        ...operation('Start durable idempotent guest/account checkout', webSecurity, 'WebCheckoutRequest', 'CheckoutResponse'),
        tags: ['Web'], parameters: [webIdempotencyParameter]
      }
    },
    '/api/web/bookings/{bookingId}/status': {
      get: {
        ...operation('Read token-bound checkout status', webSecurity, undefined, 'BookingStatusResponse'),
        tags: ['Web'], parameters: [bookingIdParameter, checkoutTokenParameter]
      }
    },
    '/api/web/me/bookings/{bookingId}/cancel': {
      post: {
        ...operation('Cancel owned booking', webSecurity, 'CancellationRequest'),
        tags: ['Web'], parameters: [bookingIdParameter]
      }
    },
    '/api/admin/bookings': {
      get: { ...operation('List bookings', adminSecurity), tags: ['Admin'] },
      post: { ...operation('Create booking', adminSecurity, 'AdminBookingCreateRequest'), tags: ['Admin'] }
    },
    '/api/admin/bookings/{bookingId}': {
      get: { ...operation('Get booking', adminSecurity), tags: ['Admin'], parameters: [bookingIdParameter] },
      patch: {
        ...operation('Update booking details; status is not accepted', adminSecurity, 'AdminBookingUpdateRequest'),
        tags: ['Admin'], parameters: [bookingIdParameter]
      }
    },
    '/api/admin/booking-quotes': {
      post: { ...operation('Create admin quote', adminSecurity, 'BookingIntent', 'QuoteResponse'), tags: ['Admin'] }
    },
    '/api/admin/booking-holds': {
      post: {
        ...operation('Create admin hold', adminSecurity, 'BookingIntent', 'HoldResponse'),
        tags: ['Admin']
      }
    },
    '/api/admin/bookings/{bookingId}/cancel': {
      post: {
        ...operation('Cancel through validated action', adminSecurity, 'AdminCancellationRequest'),
        tags: ['Admin'], parameters: [bookingIdParameter]
      }
    },
    '/api/admin/bookings/{bookingId}/no-show': {
      post: {
        ...operation('Mark no-show through validated action', adminSecurity, 'NoShowRequest'),
        tags: ['Admin'], parameters: [bookingIdParameter]
      }
    }
  },
  components: {
    securitySchemes: {
      clientBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      wordpressService: { type: 'apiKey', in: 'header', name: 'x-core-service-token' }
    },
    schemas: {
      GenericObject: { type: 'object', additionalProperties: true },
      CollectionResponse: {
        type: 'object', required: ['items'],
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/GenericObject' } } }
      },
      BookingOption: {
        type: 'object', required: ['optionId'], additionalProperties: false,
        properties: {
          optionId: uuidSchema,
          value: { type: 'string', minLength: 1, maxLength: 500 },
          quantity: { type: 'integer', minimum: 1, maximum: 100 }
        }
      },
      BookingIntent: {
        type: 'object',
        required: ['locationId', 'productId', 'locationProductId', 'startAt', 'endAt'],
        additionalProperties: false,
        properties: {
          locationId: uuidSchema,
          productId: uuidSchema,
          locationProductId: uuidSchema,
          variantId: uuidSchema,
          startAt: { type: 'string', format: 'date-time' },
          endAt: { type: 'string', format: 'date-time', description: 'Must be later than startAt.' },
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          startTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          endTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          participants: { type: 'integer', minimum: 1, maximum: 1000 },
          options: { type: 'array', maxItems: 30, default: [], items: { $ref: '#/components/schemas/BookingOption' } },
          quantities: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0, maximum: 1000 }
          },
          discountCode: { type: 'string', minLength: 1, maxLength: 100 }
        },
        anyOf: [
          { required: ['participants'] },
          { required: ['quantities'], description: 'quantities.participants must be present.' }
        ]
      },
      BookingCreateRequest: {
        allOf: [
          { $ref: '#/components/schemas/BookingIntent' },
          { type: 'object', properties: { holdId: uuidSchema } }
        ]
      },
      AdminOverrides: {
        type: 'object', additionalProperties: false,
        properties: {
          availability: { type: 'boolean', default: false },
          bookingRules: { type: 'boolean', default: false },
          createWithoutPayment: { type: 'boolean', default: false }
        }
      },
      AdminBookingCreateRequest: {
        allOf: [
          { $ref: '#/components/schemas/BookingIntent' },
          {
            type: 'object', required: ['clientId'],
            properties: {
              clientId: uuidSchema, holdId: uuidSchema,
              overrides: { $ref: '#/components/schemas/AdminOverrides' }
            }
          }
        ]
      },
      AdminBookingUpdateRequest: {
        type: 'object', minProperties: 1,
        description: 'Optimistic detail update. Booking status is intentionally not accepted.',
        properties: {
          attendees: { type: 'integer', minimum: 1 },
          bookingDate: { type: 'string' }, bookingEndDate: { type: 'string' },
          locationId: { oneOf: [uuidSchema, { type: 'null' }] },
          opsNotes: { type: 'string' }, opsStatus: { type: 'string', enum: ['Normal', 'Escalated'] },
          expectedLastUpdated: { type: 'string' }, expectedLinkedContextVersion: { type: 'string' },
          contact: { $ref: '#/components/schemas/GenericObject' },
          payment: { $ref: '#/components/schemas/GenericObject' },
          products: { type: 'array', items: { $ref: '#/components/schemas/GenericObject' } }
        }
      },
      WebAvailabilityRequest: {
        type: 'object', required: ['locationId'], additionalProperties: false,
        properties: {
          locationId: uuidSchema, variantId: uuidSchema,
          date: { type: 'string', format: 'date' },
          from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
          startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' },
          startTime: { type: 'string' }, endTime: { type: 'string' },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          quantity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
          options: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/BookingOption' } }
        }
      },
      WebCheckoutRequest: {
        type: 'object', required: ['locationId', 'productId'], additionalProperties: false,
        properties: {
          locationId: uuidSchema, productId: uuidSchema, locationProductId: uuidSchema,
          variantId: { oneOf: [uuidSchema, { type: 'null' }] },
          availabilityId: { type: 'string', minLength: 20, maxLength: 4096 },
          startAt: { type: 'string', format: 'date-time' }, endAt: { type: 'string', format: 'date-time' },
          participants: { type: 'integer', minimum: 1, maximum: 100 },
          quantity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          options: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/BookingOption' } },
          guest: { $ref: '#/components/schemas/GenericObject' },
          contact: { $ref: '#/components/schemas/GenericObject', deprecated: true }
        },
        anyOf: [
          { required: ['availabilityId'] },
          { required: ['locationProductId', 'startAt', 'endAt'] }
        ]
      },
      CancellationRequest: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 1000 } }
      },
      AdminCancellationRequest: {
        type: 'object', required: ['reason'], additionalProperties: false,
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
          reasonCode: { type: 'string', enum: ['location_closed', 'technical_issue', 'duplicate', 'staff_override', 'other'], default: 'other' },
          refundMode: { type: 'string', enum: ['policy', 'full', 'none', 'custom'], default: 'policy' },
          customRefundAmount: { type: 'integer', minimum: 0 },
          override: { type: 'boolean' }
        }
      },
      NoShowRequest: {
        type: 'object', additionalProperties: false,
        properties: { note: { type: 'string', maxLength: 1000 } }
      },
      AvailabilityResponse: {
        type: 'object', required: ['available'],
        properties: {
          available: { type: 'boolean' }, remaining: { type: ['integer', 'null'] },
          maxBookableQuantity: { type: ['integer', 'null'] },
          slots: { type: 'array', items: { $ref: '#/components/schemas/GenericObject' } }
        }
      },
      QuoteResponse: {
        type: 'object', required: ['quoteId', 'available', 'expiresAt'],
        properties: {
          quoteId: { type: 'string' }, available: { type: 'boolean' },
          expiresAt: { type: 'string', format: 'date-time' },
          configuration: { $ref: '#/components/schemas/GenericObject' },
          price: { $ref: '#/components/schemas/GenericObject' }
        }
      },
      HoldResponse: {
        type: 'object', required: ['status', 'expiresAt'],
        properties: {
          id: { oneOf: [uuidSchema, { type: 'null' }] },
          status: {
            oneOf: [
              { $ref: '#/components/schemas/HoldStatus' },
              { type: 'string', const: 'provider_managed' }
            ]
          },
          expiresAt: { type: 'string', format: 'date-time' }
        }
      },
      BookingCreateResponse: {
        type: 'object', required: ['bookingId', 'created', 'paymentRequired'],
        properties: {
          bookingId: uuidSchema, created: { type: 'boolean' }, paymentRequired: { type: 'boolean' }
        },
        additionalProperties: true
      },
      CheckoutResponse: {
        type: 'object', required: ['bookingId'],
        properties: {
          bookingId: uuidSchema,
          checkoutToken: { type: 'string', writeOnly: true },
          checkoutUrl: { type: ['string', 'null'], format: 'uri' },
          status: { type: 'string' }
        },
        additionalProperties: true
      },
      BookingStatusResponse: {
        type: 'object', required: ['bookingId', 'bookingStatus', 'paymentStatus'],
        properties: {
          bookingId: uuidSchema,
          bookingStatus: { $ref: '#/components/schemas/BookingStatus' },
          paymentStatus: { $ref: '#/components/schemas/PaymentStatus' },
          reservationExpiresAt: { type: ['string', 'null'], format: 'date-time' },
          refundStatus: { type: ['string', 'null'] },
          managementToken: { type: 'string', writeOnly: true }
        }
      },
      ErrorCode: { type: 'string', enum: errorCodes },
      ErrorDetail: {
        type: 'object', required: ['code', 'message'],
        properties: {
          code: { $ref: '#/components/schemas/ErrorCode' }, message: { type: 'string' },
          details: { type: 'object', additionalProperties: true }
        }
      },
      ErrorResponse: {
        type: 'object', required: ['error'],
        properties: {
          error: { oneOf: [{ type: 'string', deprecated: true }, { $ref: '#/components/schemas/ErrorDetail' }] },
          errorDetails: { $ref: '#/components/schemas/ErrorDetail' },
          code: { type: 'string' }, message: { type: 'string' }
        }
      },
      BookingStatus: {
        type: 'string',
        enum: ['draft', 'held', 'payment_pending', 'confirmed', 'change_requested', 'cancel_requested', 'cancelled', 'checked_in', 'in_progress', 'completed', 'no_show', 'payment_failed', 'expired']
      },
      PaymentStatus: {
        type: 'string',
        enum: ['unpaid', 'processing', 'paid', 'failed', 'refund_pending', 'partially_refunded', 'refunded', 'refund_failed']
      },
      HoldStatus: { type: 'string', enum: ['active', 'consumed', 'expired', 'released'] }
    }
  }
} as const;
