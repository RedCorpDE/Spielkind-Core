import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('client API auth guard', () => {
  const apps: Array<ReturnType<typeof createApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('rejects protected client routes with the App error contract', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/client/bookings' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: 'Missing bearer token.',
      message: 'Missing bearer token.'
    });
  });

  it('handles customer App CORS preflight requests', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/client/bookings',
      headers: { origin: 'http://localhost:8081' }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });

  it('validates public client auth payloads before database access', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/client/auth/login',
      payload: { email: 'not-an-email', password: '' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Invalid login payload.' });
  });
});
