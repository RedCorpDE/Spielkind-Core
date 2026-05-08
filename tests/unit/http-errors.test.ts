import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../../src/http/errors.js';
import { RegiondoApiError, RegiondoTransientError } from '../../src/modules/regiondo/regiondo.client.js';

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
});
