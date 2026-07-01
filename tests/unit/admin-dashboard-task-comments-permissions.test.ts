import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const taskId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';

const {
  buildAccessContextForUserMock,
  createTaskCommentMock,
  findAuthenticatedAdminBySessionMock,
  listTaskCommentsMock,
  recordAdminAuditEventMock,
  routePermissionState,
  verifyAccessTokenMock
} = vi.hoisted(() => ({
  buildAccessContextForUserMock: vi.fn(),
  createTaskCommentMock: vi.fn(),
  findAuthenticatedAdminBySessionMock: vi.fn(),
  listTaskCommentsMock: vi.fn(),
  recordAdminAuditEventMock: vi.fn(),
  routePermissionState: {
    permissions: [] as Array<{ action: string; resource: string; scope: string }>
  },
  verifyAccessTokenMock: vi.fn()
}));

vi.mock('../../src/auth/tokens.js', () => ({
  AdminAccessTokenError: class AdminAccessTokenError extends Error {},
  createAccessToken: vi.fn(() => ({ expiresAt: '2026-07-01T12:00:00.000Z', token: 'access-token' })),
  createRefreshToken: vi.fn(() => 'refresh-token'),
  verifyAccessToken: verifyAccessTokenMock
}));

vi.mock('../../src/auth/repository.js', () => ({
  createAdminSession: vi.fn(),
  findAdminUserByEmail: vi.fn(),
  findAuthenticatedAdminByRefreshToken: vi.fn(),
  findAuthenticatedAdminBySession: findAuthenticatedAdminBySessionMock,
  recordAdminAuditEvent: recordAdminAuditEventMock,
  revokeAdminSession: vi.fn(),
  rotateAdminSession: vi.fn(),
  updateAdminLastLogin: vi.fn()
}));

vi.mock('../../src/access-control/repository.js', () => ({
  buildAccessContextForUser: buildAccessContextForUserMock,
  listRoleMatrix: vi.fn(),
  replaceRolePermissions: vi.fn()
}));

vi.mock('../../src/dashboard/repository/task-comments.js', () => ({
  createTaskComment: createTaskCommentMock,
  listTaskComments: listTaskCommentsMock
}));

describe('admin dashboard task comment permissions', () => {
  beforeEach(() => {
    routePermissionState.permissions = [];
    verifyAccessTokenMock.mockReset();
    findAuthenticatedAdminBySessionMock.mockReset();
    buildAccessContextForUserMock.mockReset();
    listTaskCommentsMock.mockReset();
    createTaskCommentMock.mockReset();
    recordAdminAuditEventMock.mockReset();

    verifyAccessTokenMock.mockReturnValue({
      email: 'ada@example.com',
      exp: 1_799_999_999,
      iat: 1_700_000_000,
      name: 'Ada Lovelace',
      role: 'Custom',
      sid: 'session-1',
      sub: userId,
      type: 'access'
    });
    findAuthenticatedAdminBySessionMock.mockResolvedValue({
      sessionId: 'session-1',
      user: {
        canAccessDashboard: true,
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        id: userId,
        isActive: true,
        lastLoginAt: null,
        passwordHash: null,
        role: 'Custom'
      }
    });
    buildAccessContextForUserMock.mockImplementation(async () => ({
      permissions: routePermissionState.permissions,
      roleKey: 'custom',
      roleName: 'Custom',
      userId,
      userLocationIds: []
    }));
    listTaskCommentsMock.mockResolvedValue([]);
    createTaskCommentMock.mockResolvedValue({
      author: {
        id: userId,
        name: 'Ada Lovelace',
        role: 'Custom'
      },
      body: 'Looks good.',
      createdAt: '2026-07-01T12:00:00.000Z',
      id: '33333333-3333-3333-3333-333333333333',
      taskId
    });
    recordAdminAuditEventMock.mockResolvedValue(undefined);
  });

  it('rejects listing comments without task comment view permission', async () => {
    routePermissionState.permissions = [{ action: 'view', resource: 'tasks', scope: 'all' }];

    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'GET',
        url: `/api/admin/tasks/${taskId}/comments`
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        error: 'You do not have permission to view task comments.'
      });
      expect(listTaskCommentsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects posting comments when only task update permission is granted', async () => {
    routePermissionState.permissions = [
      { action: 'view', resource: 'tasks', scope: 'all' },
      { action: 'update', resource: 'tasks', scope: 'all' }
    ];

    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'POST',
        payload: { body: 'Looks good.' },
        url: `/api/admin/tasks/${taskId}/comments`
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        error: 'You do not have permission to create task comments.'
      });
      expect(createTaskCommentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('allows posting comments with task view and task comment create permission', async () => {
    routePermissionState.permissions = [
      { action: 'view', resource: 'tasks', scope: 'all' },
      { action: 'create', resource: 'task_comments', scope: 'all' }
    ];

    const { createApp } = await import('../../src/app.js');
    const app = createApp();

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'POST',
        payload: { body: 'Looks good.' },
        url: `/api/admin/tasks/${taskId}/comments`
      });

      expect(response.statusCode).toBe(200);
      expect(createTaskCommentMock).toHaveBeenCalledWith(taskId, {
        author: {
          id: userId,
          name: 'Ada Lovelace',
          role: 'Custom'
        },
        body: 'Looks good.'
      });
      expect(recordAdminAuditEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.task_comment.created',
          actorUserId: userId,
          details: { commentId: '33333333-3333-3333-3333-333333333333' },
          entityId: taskId,
          entityType: 'task'
        })
      );
    } finally {
      await app.close();
    }
  });
});
