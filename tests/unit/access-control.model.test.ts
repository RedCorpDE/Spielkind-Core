import { describe, expect, it } from 'vitest';
import {
  getDefaultRolePermissions,
  hasPermission,
  normalizePermissionSet,
  resolveHighestScope
} from '../../src/access-control/model.js';

describe('access control model', () => {
  it('hydrates default admin permissions with full scope', () => {
    const permissions = getDefaultRolePermissions('admin');
    const bookingsManagePermission = permissions.find(
      (permission) => permission.resource === 'bookings' && permission.action === 'manage'
    );

    expect(bookingsManagePermission?.scope).toBe('all');
  });

  it('fills unsupported permissions with none when normalizing a partial set', () => {
    const permissions = normalizePermissionSet([
      { resource: 'dashboard', action: 'view', scope: 'all' },
      { resource: 'tasks', action: 'view', scope: 'own' }
    ]);

    expect(
      permissions.find((permission) => permission.resource === 'tasks' && permission.action === 'delete')?.scope
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
