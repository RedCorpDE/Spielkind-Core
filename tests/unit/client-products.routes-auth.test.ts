import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('client product route authentication', () => {
  const apps: Array<ReturnType<typeof createApp>> = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('protects location-filtered product listings', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/client/products?locationId=11111111-1111-4111-8111-111111111111'
    });

    expect(response.statusCode).toBe(401);
  });

  it('protects venue-scoped product detail', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/client/products/22222222-2222-4222-8222-222222222222?locationId=11111111-1111-4111-8111-111111111111'
    });

    expect(response.statusCode).toBe(401);
  });
});
