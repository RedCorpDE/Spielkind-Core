import { describe, expect, it } from 'vitest';
import { buildReminderDeliveryDedupeKey } from '../../src/modules/reminders/reminder.repository.js';

describe('buildReminderDeliveryDedupeKey', () => {
  it('is deterministic for the same booking, rule, and channel', () => {
    expect(buildReminderDeliveryDedupeKey('booking-1', 'rule-1', 'email')).toBe(
      buildReminderDeliveryDedupeKey('booking-1', 'rule-1', 'email')
    );
  });

  it('changes when the channel changes', () => {
    expect(buildReminderDeliveryDedupeKey('booking-1', 'rule-1', 'email')).not.toBe(
      buildReminderDeliveryDedupeKey('booking-1', 'rule-1', 'sms')
    );
  });
});
