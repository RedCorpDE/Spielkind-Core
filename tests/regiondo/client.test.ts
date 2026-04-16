import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RegiondoClient } from '../../src/regiondo/client.js';

// Helper to create a minimal fetch Response-like object.
function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  } as unknown as Response;
}

// Replace global fetch with a controllable mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RegiondoClient.getCollection', () => {
  it('returns data array on first-try 200', async () => {
    const items = [{ id: 'p1', title: 'Laser Tag' }];
    fetchMock.mockResolvedValueOnce(makeResponse(200, { data: items }));

    const client = new RegiondoClient();
    const result = await client.getCollection<{ id: string; title: string }>('/products');

    expect(result).toEqual(items);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to items[] when data is absent', async () => {
    const items = [{ id: 'p2' }];
    fetchMock.mockResolvedValueOnce(makeResponse(200, { items }));

    const client = new RegiondoClient();
    const result = await client.getCollection('/products');

    expect(result).toEqual(items);
  });

  it('retries on 500 and succeeds on third attempt', async () => {
    const successBody = { data: [{ id: 'p3' }] };
    fetchMock
      .mockResolvedValueOnce(makeResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeResponse(200, successBody));

    const client = new RegiondoClient();
    const result = await client.getCollection('/products');

    expect(result).toEqual(successBody.data);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('propagates error after all retries exhausted on repeated 500', async () => {
    fetchMock.mockResolvedValue(makeResponse(500, 'Internal Server Error'));

    const client = new RegiondoClient();
    await expect(client.getCollection('/products')).rejects.toThrow(/500/);
    // 1 initial attempt + 3 retries = 4 total calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('does not retry on 400 (AbortError)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(400, 'Bad Request'));

    const client = new RegiondoClient();
    await expect(client.getCollection('/products')).rejects.toThrow(/400/);
    // Must not retry — only one fetch call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 Unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, 'Unauthorized'));

    const client = new RegiondoClient();
    await expect(client.getCollection('/products')).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404 Not Found', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, 'Not Found'));

    const client = new RegiondoClient();
    await expect(client.getCollection('/products')).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
