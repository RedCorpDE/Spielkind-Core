import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listSupplierBookingsMock,
  normalizeRegiondoBookingImportMock,
  purchaseOrderMock,
  queryMock,
  upsertNormalizedRegiondoBookingMock
} = vi.hoisted(() => ({
  listSupplierBookingsMock: vi.fn(),
  normalizeRegiondoBookingImportMock: vi.fn(),
  purchaseOrderMock: vi.fn(),
  queryMock: vi.fn(),
  upsertNormalizedRegiondoBookingMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: queryMock,
      release: vi.fn()
    }))
  }
}));

vi.mock('../../src/modules/regiondo/regiondo.client.js', () => ({
  regiondoClient: {
    listSupplierBookings: listSupplierBookingsMock,
    purchaseOrder: purchaseOrderMock
  }
}));

vi.mock('../../src/modules/bookings/booking-normalizer.js', () => ({
  normalizeRegiondoBookingImport: normalizeRegiondoBookingImportMock
}));

vi.mock('../../src/modules/bookings/booking.repository.js', () => ({
  upsertNormalizedRegiondoBooking: upsertNormalizedRegiondoBookingMock
}));

import { createBookingFromTask } from '../../src/dashboard/repository/bookings.js';

const createTaskBookingData = (overrides: Record<string, unknown> = {}) => ({
  contact_data: {
    email: 'family@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    phone_number: '+491234567'
  },
  email: 'family@example.com',
  options: [
    {
      option_id: 'opt-1',
      product_id: 'prod-1',
      variation_id: 'var-1'
    }
  ],
  qty: 1,
  ...overrides
});

const createTaskRow = (bookingData: Record<string, unknown>, description = 'Single-product order') => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Confirm booking',
  description,
  created_at: '2026-05-12T10:00:00.000Z',
  updated_at: '2026-05-12T10:00:00.000Z',
  connected_booking_key: null,
  update_log: [],
  raw_json: {
    site: 'Berlin',
    booking_data: bookingData
  },
  event_date_time: '2026-05-13T07:00:00.000Z',
  reminder_date: null,
  reserved_capacity_date: null,
  column_id: '22222222-2222-2222-2222-222222222222',
  column_title: 'Confirmed',
  column_position: 3,
  booking_related: true,
  assignee_user_id: null,
  owner_name: null,
  owner_role: null
});

const mockTaskForBookingCreation = (bookingData: Record<string, unknown>, description?: string) => {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('FROM tasks t') && sql.includes('FOR UPDATE OF t')) {
      return {
        rowCount: 1,
        rows: [createTaskRow(bookingData, description)]
      };
    }

    return { rowCount: 0, rows: [] };
  });
};

const mockSingleRegiondoBookingSuccess = () => {
  purchaseOrderMock.mockResolvedValue({
    info_generated_at: '2026-05-12T10:00:01.000Z',
    items: [
      {
        booking_key: 'booking-key-1',
        payment_status: 'paid',
        price_per_one_incl_tax: 49,
        product_id: 'prod-1',
        row_total_incl_tax: 49,
        ticket_name: 'Product One',
        ticket_qty: 1
      }
    ],
    order_number: 'order-123',
    purchased_at: '2026-05-12T10:00:00.000Z'
  });

  listSupplierBookingsMock.mockResolvedValue([
    {
      booking_key: 'booking-key-1',
      order_number: 'order-123',
      event_date_time: '2026-05-13 09:00:00',
      duration_type: 'hour',
      duration_value: 1,
      product_id: 'prod-1',
      qty: 1,
      status: 'confirmed'
    }
  ]);

  normalizeRegiondoBookingImportMock.mockReturnValue({
    bookingKey: 'booking-key-1',
    client: {
      email: 'family@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phoneNumber: '+491234567',
      raw: null,
      regiondoCustomerId: null
    },
    dtFrom: '2026-05-13T07:00:00.000Z',
    dtTo: '2026-05-13T08:00:00.000Z',
    guestCount: 1,
    items: [
      {
        quantity: 1,
        raw: null,
        regiondoProductId: 'prod-1',
        title: 'Product One',
        unitPrice: 49
      }
    ],
    location: {
      raw: null,
      regiondoLocationId: null,
      title: 'Berlin'
    },
    orderNumber: 'order-123',
    paidAmount: 49,
    payments: [],
    raw: null,
    snapshotGeneratedAt: '2026-05-12T10:00:01.000Z',
    status: 'confirmed',
    totalAmount: 49
  });

  upsertNormalizedRegiondoBookingMock.mockResolvedValue({
    bookingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  });
};

describe('task booking links', () => {
  beforeEach(() => {
    listSupplierBookingsMock.mockReset();
    normalizeRegiondoBookingImportMock.mockReset();
    purchaseOrderMock.mockReset();
    queryMock.mockReset();
    upsertNormalizedRegiondoBookingMock.mockReset();
  });

  it('links every Regiondo booking created for a multi-product task order', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes('FROM tasks t') && sql.includes('FOR UPDATE OF t')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              title: 'Confirm booking',
              description: 'Two-product order',
              created_at: '2026-05-12T10:00:00.000Z',
              updated_at: '2026-05-12T10:00:00.000Z',
              connected_booking_key: null,
              update_log: [],
              raw_json: {
                site: 'Berlin',
                booking_data: {
                  contact_data: {
                    email: 'family@example.com',
                    first_name: 'Ada',
                    last_name: 'Lovelace',
                    phone_number: '+491234567'
                  },
                  options: [
                    {
                      option_id: 'opt-1',
                      product_id: 'prod-1',
                      variation_id: 'var-1'
                    },
                    {
                      option_id: 'opt-2',
                      product_id: 'prod-2',
                      variation_id: 'var-2'
                    }
                  ],
                  qty: 1
                }
              },
              event_date_time: '2026-05-13T07:00:00.000Z',
              reminder_date: null,
              reserved_capacity_date: null,
              column_id: '22222222-2222-2222-2222-222222222222',
              column_title: 'Confirmed',
              column_position: 3,
              booking_related: true,
              assignee_user_id: null,
              owner_name: null,
              owner_role: null
            }
          ]
        };
      }

      return { rowCount: 0, rows: [] };
    });

    purchaseOrderMock.mockResolvedValue({
      info_generated_at: '2026-05-12T10:00:01.000Z',
      items: [
        {
          booking_key: 'booking-key-1',
          payment_status: 'paid',
          price_per_one_incl_tax: 49,
          product_id: 'prod-1',
          row_total_incl_tax: 49,
          ticket_name: 'Product One',
          ticket_qty: 1
        },
        {
          booking_key: 'booking-key-2',
          payment_status: 'paid',
          price_per_one_incl_tax: 79,
          product_id: 'prod-2',
          row_total_incl_tax: 79,
          ticket_name: 'Product Two',
          ticket_qty: 1
        }
      ],
      order_number: 'order-123',
      purchased_at: '2026-05-12T10:00:00.000Z'
    });

    listSupplierBookingsMock.mockImplementation(async ({ bookingKey }: { bookingKey: string }) => [
      {
        booking_key: bookingKey,
        order_number: 'order-123',
        event_date_time: '2026-05-13 09:00:00',
        duration_type: 'hour',
        duration_value: 1,
        product_id: bookingKey === 'booking-key-1' ? 'prod-1' : 'prod-2',
        qty: 1,
        status: 'confirmed'
      }
    ]);

    normalizeRegiondoBookingImportMock.mockImplementation(({ bookingKey }: { bookingKey: string }) => ({
      bookingKey,
      client: {
        email: 'family@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneNumber: '+491234567',
        raw: null,
        regiondoCustomerId: null
      },
      dtFrom: '2026-05-13T07:00:00.000Z',
      dtTo: '2026-05-13T08:00:00.000Z',
      guestCount: 1,
      items: [
        {
          quantity: 1,
          raw: null,
          regiondoProductId: bookingKey === 'booking-key-1' ? 'prod-1' : 'prod-2',
          title: bookingKey === 'booking-key-1' ? 'Product One' : 'Product Two',
          unitPrice: bookingKey === 'booking-key-1' ? 49 : 79
        }
      ],
      location: {
        raw: null,
        regiondoLocationId: null,
        title: 'Berlin'
      },
      orderNumber: 'order-123',
      paidAmount: bookingKey === 'booking-key-1' ? 49 : 79,
      payments: [],
      raw: null,
      snapshotGeneratedAt: '2026-05-12T10:00:01.000Z',
      status: 'confirmed',
      totalAmount: bookingKey === 'booking-key-1' ? 49 : 79
    }));

    upsertNormalizedRegiondoBookingMock
      .mockResolvedValueOnce({ bookingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
      .mockResolvedValueOnce({ bookingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });

    await expect(createBookingFromTask('11111111-1111-1111-1111-111111111111')).resolves.toEqual({
      bookingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    expect(upsertNormalizedRegiondoBookingMock).toHaveBeenCalledTimes(2);
    expect(normalizeRegiondoBookingImportMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bookingKey: 'booking-key-1' })
    );
    expect(normalizeRegiondoBookingImportMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ bookingKey: 'booking-key-2' })
    );
    expect(purchaseOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ date_time: '2026-05-13 09:00:00' }),
          expect.objectContaining({ date_time: '2026-05-13 09:00:00' })
        ]
      })
    );

    const taskBookingLinkInserts = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO task_bookings')
    );
    expect(taskBookingLinkInserts).toHaveLength(2);
    expect(taskBookingLinkInserts.map(([, values]) => values?.[1])).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    ]);

    const bookingNotesInsert = queryMock.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO booking_admin_metadata')
    );
    expect(bookingNotesInsert?.[1]).toEqual([
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
      'Two-product order'
    ]);
  });

  it('uses the alternate Regiondo booking email when the task flag is enabled', async () => {
    const bookingData = createTaskBookingData({
      regiondo_booking_email: 'tickets@example.com',
      send_regiondo_bookings_to_alternate_email: true
    });
    mockTaskForBookingCreation(bookingData);
    mockSingleRegiondoBookingSuccess();

    await expect(createBookingFromTask('11111111-1111-1111-1111-111111111111')).resolves.toEqual({
      bookingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    expect(bookingData.email).toBe('family@example.com');
    expect(purchaseOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactData: expect.objectContaining({
          email: 'tickets@example.com',
          firstname: 'Ada',
          lastname: 'Lovelace'
        })
      })
    );
  });

  it('rejects alternate Regiondo email tasks when the alternate address is missing', async () => {
    mockTaskForBookingCreation(
      createTaskBookingData({
        regiondo_booking_email: '',
        send_regiondo_bookings_to_alternate_email: true
      })
    );

    await expect(createBookingFromTask('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      'Task booking_data.regiondo_booking_email is required when alternate Regiondo email is enabled.'
    );

    expect(purchaseOrderMock).not.toHaveBeenCalled();
  });

  it('keeps using the primary task email when the alternate Regiondo flag is disabled', async () => {
    mockTaskForBookingCreation(
      createTaskBookingData({
        regiondo_booking_email: 'tickets@example.com',
        send_regiondo_bookings_to_alternate_email: false
      })
    );
    mockSingleRegiondoBookingSuccess();

    await expect(createBookingFromTask('11111111-1111-1111-1111-111111111111')).resolves.toEqual({
      bookingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    expect(purchaseOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactData: expect.objectContaining({
          email: 'family@example.com'
        })
      })
    );
  });
});
