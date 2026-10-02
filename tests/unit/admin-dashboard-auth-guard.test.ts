import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { appConfig } = await import('../../src/config/env.js');

const missingBearerResponse = {
  ok: false,
  error: 'Missing bearer token.',
  code: 'AUTHENTICATION_REQUIRED',
  message: 'Missing bearer token.',
  errorDetails: { code: 'AUTHENTICATION_REQUIRED', message: 'Missing bearer token.' }
};

const protectedReadPaths = [
  '/api/admin/users',
  '/api/admin/locations',
  '/api/admin/regiondo/location-candidates',
  '/api/admin/locations/00000000-0000-0000-0000-000000000001',
  '/api/admin/locations/00000000-0000-0000-0000-000000000001/products',
  '/api/admin/products/00000000-0000-0000-0000-000000000002/availability?locationId=00000000-0000-0000-0000-000000000001&start=2026-10-10T18%3A00%3A00.000Z&end=2026-10-10T22%3A00%3A00.000Z&quantity=1',
  '/api/admin/task-booking-options',
  '/api/admin/task-columns',
  '/api/admin/task-columns/00000000-0000-0000-0000-000000000001',
  '/api/admin/tasks',
  '/api/admin/tasks/00000000-0000-0000-0000-000000000001',
  '/api/admin/tasks/00000000-0000-0000-0000-000000000001/booking-context',
  '/api/admin/tasks/00000000-0000-0000-0000-000000000001/comments',
  '/api/admin/bookings/00000000-0000-0000-0000-000000000001/tasks',
  '/api/admin/clients',
  '/api/admin/clients/00000000-0000-0000-0000-000000000001',
  '/api/admin/clients/00000000-0000-0000-0000-000000000001/bookings',
  '/api/admin/error-events',
  '/api/admin/deleted-tasks'
] as const;

const protectedWritePaths = [
  {
    method: 'POST',
    path: '/api/admin/products',
    body: { title: 'Core product', baseAmount: 2000, vatBasisPoints: 1900 }
  },
  {
    method: 'POST',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/clone',
    body: {}
  },
  {
    method: 'DELETE',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002',
    body: {}
  },
  {
    method: 'POST',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/variants',
    body: { title: '4 Hours', priceMinor: 2000, currency: 'EUR' }
  },
  {
    method: 'PATCH',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/variants/00000000-0000-0000-0000-000000000003',
    body: { priceMinor: 2500 }
  },
  {
    method: 'DELETE',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/variants/00000000-0000-0000-0000-000000000003',
    body: {}
  },
  {
    method: 'POST',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/variants/00000000-0000-0000-0000-000000000003/options',
    body: {
      title: 'Headset',
      values: [],
      priceDeltaMinor: 300,
      currency: 'EUR'
    }
  },
  {
    method: 'POST',
    path: '/api/admin/products/00000000-0000-0000-0000-000000000002/core-migration/prepare',
    body: {}
  },
  {
    method: 'PATCH',
    path: '/api/admin/bookings/00000000-0000-0000-0000-000000000001',
    body: { opsNotes: 'Follow up with provider.' }
  },
  {
    method: 'POST',
    path: '/api/admin/locations/00000000-0000-0000-0000-000000000001/products/00000000-0000-0000-0000-000000000002',
    body: {}
  },
  {
    method: 'DELETE',
    path: '/api/admin/locations/00000000-0000-0000-0000-000000000001/products/00000000-0000-0000-0000-000000000002',
    body: {}
  },
  {
    method: 'POST',
    path: '/api/admin/locations/00000000-0000-0000-0000-000000000001/regiondo-mapping',
    body: { sourceLocationId: '00000000-0000-0000-0000-000000000002' }
  },
  {
    method: 'POST',
    path: '/api/admin/tasks/00000000-0000-0000-0000-000000000001/comments',
    body: { body: 'Looks good.' }
  },
  {
    method: 'PATCH',
    path: '/api/admin/tasks/00000000-0000-0000-0000-000000000001/with-linked-bookings',
    body: {
      task: {
        columnId: null,
        description: '',
        eventDateTime: null,
        site: '',
        title: 'Linked task'
      }
    }
  }
] as const;

describe('admin dashboard read auth guards', () => {
  it('allows CORS preflight requests for PUT role-permission updates', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    const allowedOrigin = appConfig.DASHBOARD_ALLOWED_ORIGIN[0] ?? 'http://localhost:5173';

    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/admin/access-control/roles/admin/permissions',
        headers: {
          origin: allowedOrigin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'Authorization,Content-Type'
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
      expect(response.headers['access-control-allow-methods']).toContain('PUT');
    } finally {
      await app.close();
    }
  });

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
        expect(response.json()).toEqual(missingBearerResponse);
      } finally {
        await app.close();
      }
    });
  }

  for (const { body, method, path } of protectedWritePaths) {
    it(`rejects unauthenticated access to ${method} ${path}`, async () => {
      const { createApp } = await import('../../src/app.js');
      const app = createApp();

      try {
        const response = await app.inject({
          method,
          url: path,
          payload: body
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(missingBearerResponse);
      } finally {
        await app.close();
      }
    });
  }
});
