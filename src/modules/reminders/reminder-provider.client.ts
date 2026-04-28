import { createHmac, randomUUID } from 'node:crypto';
import { appConfig } from '../../config/env.js';

export class ReminderProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderProviderError';
  }
}

export class ReminderProviderTransientError extends ReminderProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderProviderTransientError';
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildSignature(input: { timestamp: string; eventId: string; body: string }): string {
  return createHmac('sha256', appConfig.REMINDER_PROVIDER_SECRET)
    .update(`${input.timestamp}.${input.eventId}.${input.body}`)
    .digest('hex');
}

export async function sendReminderProviderEvent(payload: Record<string, unknown>): Promise<{
  eventId: string;
  responseBody: unknown;
}> {
  const eventId = randomUUID();
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const signature = buildSignature({ timestamp, eventId, body });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(appConfig.REMINDER_PROVIDER_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Core-Event-Id': eventId,
        'X-Core-Timestamp': timestamp,
        'X-Core-Signature': signature
      },
      body
    });

    if (response.ok) {
      return {
        eventId,
        responseBody: await response.json().catch(async () => await response.text())
      };
    }

    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      if (attempt === 3) {
        throw new ReminderProviderTransientError(`Reminder provider transient failure: ${response.status}`);
      }

      await sleep(250 * 2 ** attempt);
      continue;
    }

    throw new ReminderProviderError(`Reminder provider rejected request with status ${response.status}`);
  }

  throw new ReminderProviderTransientError('Reminder provider request exhausted retries.');
}

export function buildReminderProviderSignatureForTest(input: {
  timestamp: string;
  eventId: string;
  body: string;
}): string {
  return buildSignature(input);
}
