import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { enqueueRegiondoWebhookMock, runProcessRegiondoWebhookInboxJobMock } = vi.hoisted(() => ({
  enqueueRegiondoWebhookMock: vi.fn(),
  runProcessRegiondoWebhookInboxJobMock: vi.fn()
}));

vi.mock('../../src/modules/regiondo/regiondo-webhook.service.js', () => ({
  RegiondoWebhookValidationError: class RegiondoWebhookValidationError extends Error {},
  enqueueRegiondoWebhook: enqueueRegiondoWebhookMock
}));

vi.mock('../../src/modules/regiondo/regiondo-webhook-inbox.job.js', () => ({
  runProcessRegiondoWebhookInboxJob: runProcessRegiondoWebhookInboxJobMock
}));

describe('Regiondo webhook route', () => {
  beforeEach(() => {
    enqueueRegiondoWebhookMock.mockReset();
    runProcessRegiondoWebhookInboxJobMock.mockReset();
    process.env.WEBHOOK_BOOKINGS_PATH = '/webhooks/regiondo/bookings';
  });

  it('exposes the booking webhook health check at the exact Regiondo path', async () => {
    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/webhooks/regiondo/bookings'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('accepts Regiondo booking webhooks on the exact path and kicks processing immediately', async () => {
    enqueueRegiondoWebhookMock.mockResolvedValue({
      insertedCount: 2,
      duplicate: false
    });
    runProcessRegiondoWebhookInboxJobMock.mockResolvedValue({
      recordsProcessed: 0,
      metadata: { claimed: 0, deadLetterCount: 0, retriedCount: 0 }
    });

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/regiondo/bookings',
        headers: {
          'x-test-webhook-auth': 'test-webhook-token'
        },
        payload: {
          id: 'booking-1',
          status: 'confirmed'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        accepted: true,
        duplicate: false,
        inserted_events: 2
      });
      expect(enqueueRegiondoWebhookMock).toHaveBeenCalledTimes(1);
      expect(runProcessRegiondoWebhookInboxJobMock).toHaveBeenCalledWith({ limit: 2 });
    } finally {
      await app.close();
    }
  });
});
