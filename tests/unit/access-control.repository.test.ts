import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  connectMock,
  getRoleByIdentifierMock,
  listRolesMock,
  poolQueryMock,
  releaseMock
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  getRoleByIdentifierMock: vi.fn(),
  listRolesMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    query: poolQueryMock,
    connect: connectMock
  }
}));

vi.mock('../../src/dashboard/repository/roles.js', () => ({
  getRoleByIdentifier: getRoleByIdentifierMock,
  listRoles: listRolesMock
}));

import { replaceRolePermissions, resolvePermissionsForRoleName } from '../../src/access-control/repository.js';

describe('access control repository', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    connectMock.mockReset();
    getRoleByIdentifierMock.mockReset();
    listRolesMock.mockReset();
    releaseMock.mockReset();
  });

  it('reads stored permissions through role_key', async () => {
    getRoleByIdentifierMock.mockResolvedValue({
      key: 'operations',
      name: 'Operations',
      description: null,
      isSystem: false
    });
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ role_key: 'operations', resource: 'dashboard', action: 'view', scope: 'all' }]
    });

    const permissions = await resolvePermissionsForRoleName('Operations');

    expect(
      permissions.find((permission) => permission.resource === 'dashboard' && permission.action === 'view')?.scope
    ).toBe('all');
  });

  it('writes stored permissions through role_key', async () => {
    const clientQueryMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined);

    getRoleByIdentifierMock.mockResolvedValue({
      key: 'operations',
      name: 'Operations',
      description: null,
      isSystem: false
    });
    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });

    const permissions = await replaceRolePermissions('operations', [
      { resource: 'dashboard', action: 'view', scope: 'all' }
    ]);

    expect(
      clientQueryMock.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('DELETE FROM role_permissions') &&
          call[0].includes('role_key = $1') &&
          call[1]?.[0] === 'operations'
      )
    ).toBe(true);

    expect(
      clientQueryMock.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO role_permissions') &&
          call[0].includes('role_key') &&
          call[1]?.[0] === 'operations'
      )
    ).toBe(true);

    expect(permissions.find((permission) => permission.resource === 'dashboard' && permission.action === 'view')?.scope).toBe(
      'all'
    );
    expect(releaseMock).toHaveBeenCalled();
  });
});
