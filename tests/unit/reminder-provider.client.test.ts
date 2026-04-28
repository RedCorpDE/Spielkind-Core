import { describe, expect, it } from 'vitest';
import { buildReminderProviderSignatureForTest } from '../../src/modules/reminders/reminder-provider.client.js';

describe('buildReminderProviderSignatureForTest', () => {
  it('is deterministic for identical event payloads', () => {
    const input = {
      timestamp: '2026-05-01T09:00:00.000Z',
      eventId: 'e8ca2a75-fb98-44e9-8ad0-7906941d3671',
      body: JSON.stringify({ event_type: 'booking_reminder', channel: 'email' })
    };

    expect(buildReminderProviderSignatureForTest(input)).toBe(
      buildReminderProviderSignatureForTest(input)
    );
  });

  it('changes when the payload body changes', () => {
    const baseInput = {
      timestamp: '2026-05-01T09:00:00.000Z',
      eventId: 'e8ca2a75-fb98-44e9-8ad0-7906941d3671'
    };

    expect(
      buildReminderProviderSignatureForTest({
        ...baseInput,
        body: JSON.stringify({ channel: 'email' })
      })
    ).not.toBe(
      buildReminderProviderSignatureForTest({
        ...baseInput,
        body: JSON.stringify({ channel: 'sms' })
      })
    );
  });
});
