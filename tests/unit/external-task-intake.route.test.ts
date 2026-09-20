import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { createExternalClientEmailTaskMock, ExternalTaskIntakeConflictErrorMock } = vi.hoisted(() => ({
  createExternalClientEmailTaskMock: vi.fn(),
  ExternalTaskIntakeConflictErrorMock: class ExternalTaskIntakeConflictError extends Error {}
}));

vi.mock('../../src/modules/external-task-intake/external-task-intake.service.js', () => ({
  createExternalClientEmailTask: createExternalClientEmailTaskMock,
  ExternalTaskIntakeConflictError: ExternalTaskIntakeConflictErrorMock
}));

const validPayload = {
  description: 'Parsed request from the client email.',
  email: 'family@example.com',
  eventDateTime: '2026-07-01T10:00:00.000Z',
  externalMessageId: 'message-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  originalClientEmail: 'Hello, we would like to book...',
  site: 'Berlin',
  title: 'Birthday booking inquiry'
};

describe('external task intake route', () => {
  beforeEach(() => {
    createExternalClientEmailTaskMock.mockReset();
    process.env.EXTERNAL_TASK_WEBHOOK_PATH = '/webhooks/external/client-emails';
    process.env.EXTERNAL_TASK_WEBHOOK_AUTH_HEADER_NAME = 'x-external-task-secret';
    process.env.EXTERNAL_TASK_WEBHOOK_AUTH_HEADER_VALUE = 'test-external-task-token';
  });

  it('rejects requests without the configured static secret', async () => {
    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        payload: validPayload
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        ok: false,
        error: 'Invalid external task webhook authentication header.'
      });
      expect(createExternalClientEmailTaskMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects invalid payloads', async () => {
    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload: {
          ...validPayload,
          externalMessageId: ''
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        ok: false,
        error: 'Invalid external task payload.',
        issues: [
          {
            field: 'externalMessageId',
            code: 'too_small'
          }
        ]
      });
      expect(createExternalClientEmailTaskMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 201 when a new external task is created', async () => {
    const task = { id: 'task-1', title: validPayload.title };
    createExternalClientEmailTaskMock.mockResolvedValue({
      created: true,
      item: task
    });

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload: validPayload
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        ok: true,
        created: true,
        item: task
      });
      expect(createExternalClientEmailTaskMock).toHaveBeenCalledWith(validPayload);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['blank', '   ']
  ])('accepts eventDateTime when it is %s', async (_label, eventDateTime) => {
    const task = { id: 'task-1', title: validPayload.title };
    createExternalClientEmailTaskMock.mockResolvedValue({
      created: true,
      item: task
    });

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const payload: Record<string, unknown> = { ...validPayload };
      if (eventDateTime === undefined) {
        delete payload.eventDateTime;
      } else {
        payload.eventDateTime = eventDateTime;
      }

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload
      });

      expect(response.statusCode).toBe(201);
      expect(createExternalClientEmailTaskMock).toHaveBeenCalledWith({
        ...payload,
        ...(eventDateTime === '   ' ? { eventDateTime: '' } : {})
      });
    } finally {
      await app.close();
    }
  });

  it('accepts the nullable optional fields sent by the Retool workflow', async () => {
    const payload = {
      externalMessageId: '69db497536bd707ba9c872abbde89507a1164467dcefda5d4232b4ada2d8d872',
      title: 'Invoice May 2026',
      description: 'Hello, attached is the invoice...',
      originalClientEmail: 'Hello, attached is the invoice...',
      site: 'VirtuaLounge',
      eventDateTime: null,
      firstName: null,
      lastName: null,
      email: 'client@example.com',
      phoneNumber: null,
      attendees: null,
      source: 'retool_client_email'
    };
    const task = { id: 'task-1', title: payload.title };
    createExternalClientEmailTaskMock.mockResolvedValue({
      created: true,
      item: task
    });

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload
      });

      expect(response.statusCode).toBe(201);
      expect(createExternalClientEmailTaskMock).toHaveBeenCalledWith(payload);
    } finally {
      await app.close();
    }
  });

  it('returns 200 when the idempotency key was already processed', async () => {
    const task = { id: 'task-1', title: validPayload.title };
    createExternalClientEmailTaskMock.mockResolvedValue({
      created: false,
      duplicate: true,
      item: task
    });

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload: validPayload
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        created: false,
        duplicate: true,
        item: task
      });
    } finally {
      await app.close();
    }
  });

  it('returns 409 when the idempotency key is reused with a different payload', async () => {
    createExternalClientEmailTaskMock.mockRejectedValue(
      new ExternalTaskIntakeConflictErrorMock('externalMessageId was already processed with a different payload.')
    );

    vi.resetModules();
    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/external/client-emails',
        headers: {
          'x-external-task-secret': 'test-external-task-token'
        },
        payload: validPayload
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        ok: false,
        error: 'externalMessageId was already processed with a different payload.'
      });
    } finally {
      await app.close();
    }
  });
});
