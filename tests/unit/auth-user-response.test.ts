import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

describe('auth user response', () => {
  it('includes the full admin auth user contract', async () => {
    const { toAuthUser } = await import('../../src/http/admin.js');

    const authUser = toAuthUser({
      id: 'user-1',
      email: 'admin@example.com',
      displayName: 'Admin User',
      role: 'admin',
      isActive: true,
      canAccessDashboard: true,
      passwordHash: 'secret',
      lastLoginAt: '2026-04-28T10:00:00.000Z'
    });

    expect(authUser).toEqual({
      id: 'user-1',
      email: 'admin@example.com',
      displayName: 'Admin User',
      role: 'admin',
      isActive: true,
      canAccessDashboard: true,
      lastLoginAt: '2026-04-28T10:00:00.000Z'
    });
  });
});
