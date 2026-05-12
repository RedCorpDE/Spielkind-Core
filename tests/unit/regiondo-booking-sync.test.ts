import { describe, expect, it } from 'vitest';
import {
  buildRegiondoBookingSyncWindow,
  collectRegiondoBookingSyncCandidates
} from '../../src/modules/regiondo/regiondo-booking-sync.service.js';

describe('buildRegiondoBookingSyncWindow', () => {
  it('falls back to the initial lookback window when no previous sync exists', () => {
    const window = buildRegiondoBookingSyncWindow({
      initialLookbackDays: 30,
      now: new Date('2026-05-12T10:15:00.000Z'),
      overlapDays: 1
    });

    expect(window).toEqual({
      cursorValue: '2026-05-12T10:15:00.000Z',
      endDate: '2026-05-12',
      startDate: '2026-04-11'
    });
  });

  it('reuses the previous sync timestamp and applies the configured overlap days', () => {
    const window = buildRegiondoBookingSyncWindow({
      initialLookbackDays: 30,
      lastSuccessAt: '2026-05-10T08:00:00.000Z',
      now: new Date('2026-05-12T10:15:00.000Z'),
      overlapDays: 1
    });

    expect(window).toEqual({
      cursorValue: '2026-05-12T10:15:00.000Z',
      endDate: '2026-05-12',
      startDate: '2026-05-09'
    });
  });
});

describe('collectRegiondoBookingSyncCandidates', () => {
  it('deduplicates booking keys and keeps the first usable order number', () => {
    const candidates = collectRegiondoBookingSyncCandidates([
      {
        booking_key: 'booking-b',
        order_number: '',
        product_id: '297021'
      },
      {
        booking_key: 'booking-a',
        order_number: 'R-10001',
        product_id: '297022'
      },
      {
        booking_key: 'booking-b',
        order_number: 'R-10002',
        product_id: '297021'
      }
    ]);

    expect(candidates).toEqual([
      {
        bookingKey: 'booking-a',
        orderNumber: 'R-10001'
      },
      {
        bookingKey: 'booking-b',
        orderNumber: 'R-10002'
      }
    ]);
  });
});
