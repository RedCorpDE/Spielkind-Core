import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const protectedReadPaths = [
  '/api/admin/users',
  '/api/admin/locations',
  '/api/admin/locations/00000000-0000-0000-0000-000000000001',
  '/api/admin/task-columns',
  '/api/admin/task-columns/00000000-0000-0000-0000-000000000001',
  '/api/admin/tasks',
  '/api/admin/tasks/00000000-0000-0000-0000-000000000001',
  '/api/admin/bookings/00000000-0000-0000-0000-000000000001/tasks',
  '/api/admin/deleted-tasks'
] as const;

describe('admin dashboard read auth guards', () => {
  for (const path of protectedReadPaths) {
    it(`rejects unauthenticated access to GET ${path}`, async () => {
      const { createApp } = await import('../../src/app.js');
      const app = createApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: path
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          ok: false,
          error: 'Missing bearer token.'
        });
      } finally {
        await app.close();
      }
    });
  }
});
