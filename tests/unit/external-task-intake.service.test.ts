import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { clientMock, connectMock, createTaskRecordMock, getTaskMock } = vi.hoisted(() => ({
  clientMock: {
    query: vi.fn(),
    release: vi.fn()
  },
  connectMock: vi.fn(),
  createTaskRecordMock: vi.fn(),
  getTaskMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    connect: connectMock
  }
}));

vi.mock('../../src/dashboard/repository/tasks.js', () => ({
  createTaskRecord: createTaskRecordMock,
  getTask: getTaskMock
}));

const {
  buildCreateTaskInputFromExternalClientEmail,
  createExternalClientEmailTask,
  ExternalTaskIntakeConflictError,
  hashExternalClientEmailTaskInput
} = await import('../../src/modules/external-task-intake/external-task-intake.service.js');

const validInput = {
  attendees: 12,
  choiceBlock: ['keep_talking'],
  description: 'Parsed request from the client email.',
  email: 'family@example.com',
  eventDateTime: '2026-07-01T10:00:00.000Z',
  externalMessageId: 'message-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  originalClientEmail: 'Hello, we would like to book...',
  paymentMethod: 'per_invoice',
  phoneNumber: '+49 30 123456',
  price: '250.00',
  site: 'Berlin',
  title: 'Birthday booking inquiry'
};

function mockIntakeEventQuery(rows: Array<{ request_hash: string; task_id: string }>) {
  clientMock.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM external_task_intake_events')) {
      return { rowCount: rows.length, rows };
    }

    return { rowCount: 1, rows: [] };
  });
}

describe('external task intake service', () => {
  beforeEach(() => {
    clientMock.query.mockReset();
    clientMock.release.mockReset();
    connectMock.mockReset().mockResolvedValue(clientMock);
    createTaskRecordMock.mockReset().mockResolvedValue('task-1');
    getTaskMock.mockReset().mockResolvedValue({
      id: 'task-1',
      activityLog: [
        {
          actor: {
            source: 'external'
          }
        }
      ],
      rawJson: {}
    });
  });

  it('maps parsed client email fields into the dashboard task rawJson shape', () => {
    const taskInput = buildCreateTaskInputFromExternalClientEmail(validInput);

    expect(taskInput).toMatchObject({
      description: validInput.description,
      eventDateTime: validInput.eventDateTime,
      site: validInput.site,
      title: validInput.title,
      rawJson: {
        booking_data: {
          attendees: 12,
          choice_block: ['keep_talking'],
          contact_data: {
            email: 'family@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
            phone_number: '+49 30 123456'
          },
          email: 'family@example.com',
          external_item_id: 'External client email service',
          og_client_email: validInput.originalClientEmail,
          payment_method: 'per_invoice',
          phone_number: '+49 30 123456',
          price: '250.00',
          site: 'Berlin'
        },
        external_intake: {
          externalMessageId: 'message-1',
          source: 'client_email_service'
        }
      }
    });
  });

  it('creates a task, records the idempotency key, and uses an external actor', async () => {
    mockIntakeEventQuery([]);

    const result = await createExternalClientEmailTask(validInput);

    expect(result.created).toBe(true);
    expect(createTaskRecordMock).toHaveBeenCalledTimes(1);
    expect(createTaskRecordMock.mock.calls[0][2]).toEqual({
      name: 'External client email service',
      role: 'Operations',
      source: 'external'
    });
    expect(clientMock.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO external_task_intake_events'),
      ['client_email_service', 'message-1', 'task-1', hashExternalClientEmailTaskInput(validInput)]
    );
    expect(getTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('returns the existing task when the same idempotency key is retried with the same payload', async () => {
    const requestHash = hashExternalClientEmailTaskInput(validInput);
    mockIntakeEventQuery([{ request_hash: requestHash, task_id: 'task-1' }]);

    const result = await createExternalClientEmailTask(validInput);

    expect(result).toMatchObject({
      created: false,
      duplicate: true
    });
    expect(createTaskRecordMock).not.toHaveBeenCalled();
    expect(getTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('rejects a reused idempotency key when the payload changed', async () => {
    mockIntakeEventQuery([{ request_hash: 'different-request-hash', task_id: 'task-1' }]);

    await expect(createExternalClientEmailTask(validInput)).rejects.toBeInstanceOf(ExternalTaskIntakeConflictError);
    expect(createTaskRecordMock).not.toHaveBeenCalled();
  });
});
