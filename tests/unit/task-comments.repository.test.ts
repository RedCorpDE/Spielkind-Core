import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    query: queryMock
  }
}));

import {
  createTaskComment,
  listTaskComments
} from '../../src/dashboard/repository/task-comments.js';

const taskId = '11111111-1111-1111-1111-111111111111';

describe('task comments repository', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('lists task comments newest first', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: taskId, is_deleted: true }]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            task_id: taskId,
            author_user_id: '22222222-2222-2222-2222-222222222222',
            author_name: 'Ada Lovelace',
            author_role: 'Operations',
            body: 'Newest comment',
            created_at: '2026-06-16T10:00:00.000Z'
          }
        ]
      });

    await expect(listTaskComments(taskId)).resolves.toEqual([
      {
        id: '33333333-3333-3333-3333-333333333333',
        taskId,
        author: {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Ada Lovelace',
          role: 'Operations'
        },
        body: 'Newest comment',
        createdAt: '2026-06-16T10:00:00.000Z'
      }
    ]);

    expect(queryMock.mock.calls[1][0]).toContain('ORDER BY created_at DESC, id DESC');
  });

  it('creates a trimmed comment with the authenticated author snapshot', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: taskId, is_deleted: false }]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            task_id: taskId,
            author_user_id: '22222222-2222-2222-2222-222222222222',
            author_name: 'Ada Lovelace',
            author_role: 'Operations',
            body: 'Ready for review',
            created_at: '2026-06-16T10:00:00.000Z'
          }
        ]
      });

    await expect(
      createTaskComment(taskId, {
        author: {
          id: '22222222-2222-2222-2222-222222222222',
          name: ' Ada Lovelace ',
          role: ' Operations '
        },
        body: '  Ready for review  '
      })
    ).resolves.toMatchObject({
      body: 'Ready for review',
      author: {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Ada Lovelace',
        role: 'Operations'
      }
    });

    expect(queryMock.mock.calls[1][1]).toEqual([
      taskId,
      '22222222-2222-2222-2222-222222222222',
      'Ada Lovelace',
      'Operations',
      'Ready for review'
    ]);
  });

  it('rejects empty comment bodies before querying the database', async () => {
    await expect(
      createTaskComment(taskId, {
        author: {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Ada Lovelace',
          role: 'Operations'
        },
        body: '   '
      })
    ).rejects.toThrow(/comment body is required/i);

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns not found for an unknown task', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 0,
      rows: []
    });

    await expect(listTaskComments(taskId)).rejects.toThrow(/task not found/i);
  });

  it('rejects posting to deleted tasks', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: taskId, is_deleted: true }]
    });

    await expect(
      createTaskComment(taskId, {
        author: {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Ada Lovelace',
          role: 'Operations'
        },
        body: 'Can we revive this?'
      })
    ).rejects.toThrow(/deleted tasks cannot be commented on/i);
  });
});
