import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('booking feedback route authentication', () => {
  const apps: Array<ReturnType<typeof createApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it.each([
    '/api/admin/feedback',
    '/api/admin/feedback/stats',
    '/api/admin/feedback/location-summaries',
    '/api/admin/feedback/11111111-1111-4111-8111-111111111111',
    '/api/admin/clients/11111111-1111-4111-8111-111111111111/feedback',
    '/api/admin/bookings/11111111-1111-4111-8111-111111111111/feedback'
  ])('protects admin feedback endpoint %s', async (url) => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('protects client feedback reads', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/client/bookings/11111111-1111-4111-8111-111111111111/feedback'
    });
    expect(response.statusCode).toBe(401);
  });

  it('protects client feedback submissions', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/client/bookings/11111111-1111-4111-8111-111111111111/feedback',
      payload: { overallRating: 5 }
    });
    expect(response.statusCode).toBe(401);
  });
});
