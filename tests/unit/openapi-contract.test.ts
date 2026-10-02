import { describe, expect, it } from 'vitest';
import { coreOpenApiDocument } from '../../src/http/openapi.js';

describe('Core OpenAPI contract', () => {
  it('documents representative client, web, and admin booking routes', () => {
    expect(coreOpenApiDocument.openapi).toBe('3.1.0');
    expect(coreOpenApiDocument.paths).toHaveProperty('/api/client/bookings/{bookingId}/checkout');
    expect(coreOpenApiDocument.paths).toHaveProperty('/api/web/checkout');
    expect(coreOpenApiDocument.paths).toHaveProperty('/api/admin/bookings/{bookingId}/cancel');
  });

  it('publishes booking, payment, hold, and stable error enums', () => {
    expect(coreOpenApiDocument.components.schemas.BookingStatus.enum).toContain('no_show');
    expect(coreOpenApiDocument.components.schemas.PaymentStatus.enum).toContain('partially_refunded');
    expect(coreOpenApiDocument.components.schemas.HoldStatus.enum).toEqual(['active', 'consumed', 'expired', 'released']);
    expect(coreOpenApiDocument.components.schemas.ErrorCode.enum).toContain('INVALID_PAYMENT_TRANSITION');
  });
});
