import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../../src/http/errors.js';
import {
  RegiondoApiError,
  RegiondoLocationValidationError,
  RegiondoPurchaseRecoveryRequiredError,
  RegiondoTransientError
} from '../../src/modules/regiondo/regiondo.client.js';

function createReplyDouble() {
  const reply = {
    send: vi.fn(),
    status: vi.fn()
  };

  reply.status.mockReturnValue(reply);
  return reply;
}

function createRequestDouble() {
  return {
    log: {
      error: vi.fn(),
      warn: vi.fn()
    }
  };
}

describe('registerErrorHandler', () => {
  it('returns a stable validation response for invalid Regiondo locations', async () => {
    const handler = registerErrorHandler();
    const reply = createReplyDouble();
    const request = createRequestDouble();

    await handler(
      new RegiondoLocationValidationError('Regiondo location ID 5467 is a region, not a city.'),
      request as never,
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      code: 'REGIONDO_LOCATION_INVALID',
      error: 'Regiondo location ID 5467 is a region, not a city.'
    });
  });

  it('returns structured 400 responses for user-fixable Regiondo API failures', async () => {
    const handler = registerErrorHandler();
    const reply = createReplyDouble();
    const request = createRequestDouble();

    await handler(
      new RegiondoApiError('Regiondo request failed with status 400', 400, '{"message":"Invalid checkout item."}'),
      request as never,
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      error: 'Regiondo request failed with status 400',
      details: '{"message":"Invalid checkout item."}'
    });
  });

  it('returns 503 responses for transient Regiondo failures', async () => {
    const handler = registerErrorHandler();
    const reply = createReplyDouble();
    const request = createRequestDouble();

    await handler(
      new RegiondoTransientError(503, 'Regiondo is temporarily unavailable.'),
      request as never,
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      error: 'Regiondo transient failure: 503',
      details: 'Regiondo is temporarily unavailable.'
    });
  });

  it('returns a non-retryable reconciliation response without provider or customer payloads', async () => {
    const handler = registerErrorHandler();
    const reply = createReplyDouble();
    const request = createRequestDouble();
    const error = new RegiondoPurchaseRecoveryRequiredError({
      reason: 'snapshot_unavailable',
      subId: 'task-1',
      orderNumber: 'R-10001',
      orderId: '4711',
      attemptCount: 5,
      upstreamStatus: 503,
      cause: new RegiondoApiError(
        'Provider failure containing booking@example.com',
        503,
        '{"contact_data":{"email":"booking@example.com"}}'
      )
    });

    await handler(error, request as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(502);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      code: 'REGIONDO_PURCHASE_RECONCILIATION_REQUIRED',
      retryable: false,
      error: 'The Regiondo purchase may already exist. Do not submit it again until the existing attempt is reconciled.',
      reason: 'snapshot_unavailable',
      subId: 'task-1',
      orderNumber: 'R-10001',
      orderId: '4711'
    });
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('booking@example.com');
  });
});
