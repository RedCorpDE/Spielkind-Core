import { describe, expect, it } from 'vitest';
import {
  getDefaultRolePermissions,
  hasPermission,
  normalizePermissionSet,
  permissionDefinitions,
  resolveHighestScope
} from '../../src/access-control/model.js';

const taskBookingOptionActions = ['view', 'create', 'update', 'delete', 'manage'] as const;
const taskCommentActions = ['view', 'create'] as const;

const expectFullTaskBookingOptionAccess = (permissions: ReturnType<typeof getDefaultRolePermissions>) => {
  for (const action of taskBookingOptionActions) {
    expect(
      permissions.find((permission) => permission.resource === 'task_booking_options' && permission.action === action)
        ?.scope
    ).toBe('all');
  }
};

const expectFullTaskCommentAccess = (permissions: ReturnType<typeof getDefaultRolePermissions>) => {
  for (const action of taskCommentActions) {
    expect(
      permissions.find((permission) => permission.resource === 'task_comments' && permission.action === action)?.scope
    ).toBe('all');
  }
};

describe('access control model', () => {
  it('defines append-only task comment permissions', () => {
    expect(permissionDefinitions.find((definition) => definition.resource === 'task_comments')?.actions).toEqual([
      'view',
      'create'
    ]);
  });

  it('hydrates default admin permissions with full scope', () => {
    const permissions = getDefaultRolePermissions('admin');
    const bookingsCreatePermission = permissions.find(
      (permission) => permission.resource === 'bookings' && permission.action === 'create'
    );
    const bookingsDeletePermission = permissions.find(
      (permission) => permission.resource === 'bookings' && permission.action === 'delete'
    );
    const bookingsManagePermission = permissions.find(
      (permission) => permission.resource === 'bookings' && permission.action === 'manage'
    );

    expect(bookingsCreatePermission?.scope).toBe('all');
    expect(bookingsDeletePermission?.scope).toBe('all');
    expect(bookingsManagePermission?.scope).toBe('all');
    expectFullTaskCommentAccess(permissions);
    expectFullTaskBookingOptionAccess(permissions);
  });

  it('preserves booking create and cancel access for operational roles', () => {
    const permissions = getDefaultRolePermissions('program_manager');

    expect(
      permissions.find((permission) => permission.resource === 'bookings' && permission.action === 'create')?.scope
    ).toBe('all');
    expect(
      permissions.find((permission) => permission.resource === 'bookings' && permission.action === 'delete')?.scope
    ).toBe('all');
    expectFullTaskCommentAccess(permissions);
  });

  it('preserves task comment access for operational roles', () => {
    expectFullTaskCommentAccess(getDefaultRolePermissions('operations'));
    expectFullTaskCommentAccess(getDefaultRolePermissions('operations_lead'));
    expectFullTaskCommentAccess(getDefaultRolePermissions('program_manager'));
  });

  it('allows operations leads to manage task booking options by default', () => {
    const permissions = getDefaultRolePermissions('operations_lead');

    expectFullTaskBookingOptionAccess(permissions);
  });

  it('fills unsupported permissions with none when normalizing a partial set', () => {
    const permissions = normalizePermissionSet([
      { resource: 'dashboard', action: 'view', scope: 'all' },
      { resource: 'tasks', action: 'view', scope: 'own' }
    ]);

    expect(
      permissions.find((permission) => permission.resource === 'tasks' && permission.action === 'delete')?.scope
    ).toBe('none');
    expect(
      permissions.find((permission) => permission.resource === 'task_comments' && permission.action === 'view')?.scope
    ).toBe('none');
    expect(
      permissions.find((permission) => permission.resource === 'task_comments' && permission.action === 'create')?.scope
    ).toBe('none');
  });

  it('returns the highest scope by rank', () => {
    expect(resolveHighestScope(['none', 'own', 'location'])).toBe('location');
    expect(resolveHighestScope(['none', 'all', 'own'])).toBe('all');
  });

  it('checks target-aware permissions for own and location scopes', () => {
    const ownContext = {
      userId: 'user-1',
      roleKey: 'custom',
      roleName: 'Custom',
      userLocationIds: ['location-1'],
      permissions: normalizePermissionSet([
        { resource: 'tasks', action: 'update', scope: 'own' },
        { resource: 'bookings', action: 'view', scope: 'location' }
      ])
    };

    expect(
      hasPermission(ownContext, 'tasks', 'update', {
        ownerUserId: 'user-1'
      })
    ).toBe(true);

    expect(
      hasPermission(ownContext, 'tasks', 'update', {
        ownerUserId: 'user-2'
      })
    ).toBe(false);

    expect(
      hasPermission(ownContext, 'bookings', 'view', {
        locationId: 'location-1'
      })
    ).toBe(true);

    expect(
      hasPermission(ownContext, 'bookings', 'view', {
        locationId: 'location-2'
      })
    ).toBe(false);
  });
});
