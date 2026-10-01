import { describe, expect, it } from 'vitest';
import { generateStartClocks } from '../../src/modules/bookings/booking-slot.service.js';

describe('Core customer-selectable start slots', () => {
  it('generates starts from the requested earliest time at the independent interval', () => {
    expect(generateStartClocks({ requested: '12:00', min: '10:00', max: '14:00', intervalMinutes: 30 }))
      .toEqual(['12:00', '12:30', '13:00', '13:30', '14:00']);
  });

  it('keeps duration independent from the start interval', () => {
    const starts = generateStartClocks({ requested: '12:00', min: '12:00', max: '13:00', intervalMinutes: 30 });
    expect(starts.map((start) => {
      const [hour, minute] = start.split(':').map(Number);
      const end = hour * 60 + minute + 120;
      return `${start}-${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
    })).toEqual(['12:00-14:00', '12:30-14:30', '13:00-15:00']);
  });

  it('never generates starts outside the configured min/max', () => {
    expect(generateStartClocks({ requested: '09:15', min: '12:00', max: '13:00', intervalMinutes: 30 }))
      .toEqual(['12:00', '12:30', '13:00']);
    expect(generateStartClocks({ requested: '18:30', min: '12:00', max: '18:00', intervalMinutes: 30 }))
      .toEqual([]);
  });
});
