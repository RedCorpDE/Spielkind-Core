import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SLACK_URL = 'https://hooks.slack.com/services/test/webhook/url';

// Mutable config object so tests can toggle alerting on/off.
const mockConfig = {
  ALERTING_ENABLED: true,
  ALERT_SLACK_WEBHOOK_URL: SLACK_URL as string | undefined
};

vi.mock('../../src/config.js', () => ({
  appConfig: mockConfig
}));

// Control fetch globally.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

// Import after mocks are registered.
const { sendAlert, _resetDedupState } = await import('../../src/alerts/slack-notifier.js');

beforeEach(() => {
  vi.clearAllMocks();
  _resetDedupState();
  mockConfig.ALERTING_ENABLED = true;
  mockConfig.ALERT_SLACK_WEBHOOK_URL = SLACK_URL;
});

afterEach(() => {
  mockConfig.ALERTING_ENABLED = false;
  mockConfig.ALERT_SLACK_WEBHOOK_URL = undefined;
});

describe('sendAlert — alerting disabled', () => {
  it('does not call fetch when ALERTING_ENABLED is false', async () => {
    mockConfig.ALERTING_ENABLED = false;

    await sendAlert('error', 'Something went wrong');
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call fetch when ALERT_SLACK_WEBHOOK_URL is not set', async () => {
    mockConfig.ALERT_SLACK_WEBHOOK_URL = undefined;

    await sendAlert('error', 'Something went wrong');
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendAlert — normal delivery', () => {
  it('sends a POST to the Slack webhook URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await sendAlert('error', 'Sync failed');
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SLACK_URL);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('includes the message and level in the payload body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await sendAlert('fatal', 'DB connection lost', { syncId: 'abc-123' });
    await new Promise((r) => setTimeout(r, 20));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('FATAL');
    expect(body.text).toContain('DB connection lost');
  });
});

describe('sendAlert — deduplication', () => {
  it('sends only once for identical alert within 15 minutes', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await sendAlert('error', 'Repeated error');
    await sendAlert('error', 'Repeated error');
    await sendAlert('error', 'Repeated error');
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends again after dedup state is reset', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await sendAlert('error', 'Repeated error');
    _resetDedupState();
    await sendAlert('error', 'Repeated error');
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends separate alerts for different messages', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await sendAlert('error', 'Error A');
    await sendAlert('error', 'Error B');
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends separate alerts for different levels with the same message', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await sendAlert('error', 'Critical failure');
    await sendAlert('fatal', 'Critical failure');
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('sendAlert — fire-and-forget error handling', () => {
  it('does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(sendAlert('error', 'Test error')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    // No thrown error — fire-and-forget means the rejection is only logged.
  });
});
