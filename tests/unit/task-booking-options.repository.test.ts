import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  connectMock,
  poolQueryMock,
  releaseMock
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    query: poolQueryMock,
    connect: connectMock
  }
}));

import {
  createTaskBookingOption,
  deleteTaskBookingOption,
  listTaskBookingOptions,
  reorderTaskBookingOptions,
  updateTaskBookingOption
} from '../../src/dashboard/repository/task-booking-options.js';

const createOptionRow = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  group_key: 'catering_size',
  value: 'size_m',
  label_en: 'Size M',
  label_de: 'Größe M',
  position: 0,
  is_active: true,
  created_at: '2026-06-30T08:00:00.000Z',
  updated_at: '2026-06-30T08:00:00.000Z',
  ...overrides
});

describe('task booking options repository', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    connectMock.mockReset();
    releaseMock.mockReset();
  });

  it('lists default options in stable group and position order', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        createOptionRow({ group_key: 'catering_size', value: 'size_m', position: 0 }),
        createOptionRow({
          id: '22222222-2222-2222-2222-222222222222',
          group_key: 'beverage_package',
          value: 'all_inclusive',
          label_en: 'All inclusive',
          label_de: 'All Inclusive',
          position: 1
        }),
        createOptionRow({
          id: '33333333-3333-3333-3333-333333333333',
          group_key: 'choice_block',
          value: 'keep_talking',
          label_en: 'Keep Talking',
          label_de: 'Keep Talking',
          position: 0
        })
      ]
    });

    const options = await listTaskBookingOptions();

    expect(poolQueryMock.mock.calls[0]?.[0]).toContain('ORDER BY array_position');
    expect(options.map((option) => `${option.groupKey}:${option.value}`)).toEqual([
      'catering_size:size_m',
      'beverage_package:all_inclusive',
      'choice_block:keep_talking'
    ]);
  });

  it('rejects duplicate generated values on create', async () => {
    const clientQueryMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'task_booking_options_group_value_unique'
      })
      .mockResolvedValue(undefined);

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });

    await expect(
      createTaskBookingOption({
        groupKey: 'catering_size',
        labelDe: 'Größe M',
        labelEn: 'Size M'
      })
    ).rejects.toThrow('A task booking option with this value already exists.');

    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('updates labels and active state without changing the stable value', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [createOptionRow()]
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          createOptionRow({
            label_en: 'Medium catering',
            label_de: 'Catering M',
            is_active: false
          })
        ]
      });

    const option = await updateTaskBookingOption('11111111-1111-1111-1111-111111111111', {
      isActive: false,
      labelDe: 'Catering M',
      labelEn: 'Medium catering'
    });

    expect(poolQueryMock.mock.calls[1]?.[0]).not.toContain('value =');
    expect(poolQueryMock.mock.calls[1]?.[1]).toEqual([
      'Medium catering',
      'Catering M',
      false,
      '11111111-1111-1111-1111-111111111111'
    ]);
    expect(option.value).toBe('size_m');
    expect(option.isActive).toBe(false);
  });

  it('rejects deleting options that are referenced by task booking data', async () => {
    const clientQueryMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [createOptionRow()]
      })
      .mockResolvedValueOnce({
        rows: [{ is_referenced: true }]
      })
      .mockResolvedValue(undefined);

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });

    await expect(deleteTaskBookingOption('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      'Task booking option is still used by tasks. Deactivate it instead.'
    );

    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('deletes unused options and compacts the group order', async () => {
    const clientQueryMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [createOptionRow()]
      })
      .mockResolvedValueOnce({
        rows: [{ is_referenced: false }]
      })
      .mockResolvedValueOnce({
        rows: [createOptionRow()]
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });

    await expect(deleteTaskBookingOption('11111111-1111-1111-1111-111111111111')).resolves.toBeUndefined();

    expect(clientQueryMock.mock.calls.some((call) => String(call[0]).includes('DELETE FROM task_booking_options'))).toBe(
      true
    );
    expect(clientQueryMock).toHaveBeenCalledWith('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('requires reorders to include every option in the target group', async () => {
    const clientQueryMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [
          createOptionRow(),
          createOptionRow({
            id: '22222222-2222-2222-2222-222222222222',
            value: 'size_l',
            label_en: 'Size L',
            label_de: 'Größe L',
            position: 1
          })
        ]
      })
      .mockResolvedValue(undefined);

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });

    await expect(
      reorderTaskBookingOptions({
        groupKey: 'catering_size',
        orderedOptionIds: ['22222222-2222-2222-2222-222222222222']
      })
    ).rejects.toThrow('orderedOptionIds must include every task booking option in the group exactly once.');

    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });
});
