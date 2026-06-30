import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../src/sync/mappers.js';

const {
  clientQueryMock,
  hydrateBookingOrderMock,
  normalizeRegiondoBookingImportMock,
  poolQueryMock,
  rebuildConsumptionsForBookingMock,
  releaseMock,
  updateBookingMock,
  upsertNormalizedRegiondoBookingMock
} = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  hydrateBookingOrderMock: vi.fn(),
  normalizeRegiondoBookingImportMock: vi.fn(),
  poolQueryMock: vi.fn(),
  rebuildConsumptionsForBookingMock: vi.fn(),
  releaseMock: vi.fn(),
  updateBookingMock: vi.fn(),
  upsertNormalizedRegiondoBookingMock: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock
    })),
    query: poolQueryMock
  }
}));

vi.mock('../../src/modules/regiondo/regiondo.client.js', () => ({
  regiondoClient: {
    hydrateBookingOrder: hydrateBookingOrderMock,
    updateBooking: updateBookingMock
  }
}));

vi.mock('../../src/modules/bookings/booking-normalizer.js', () => ({
  normalizeRegiondoBookingImport: normalizeRegiondoBookingImportMock
}));

vi.mock('../../src/modules/bookings/booking.repository.js', () => ({
  upsertNormalizedRegiondoBooking: upsertNormalizedRegiondoBookingMock
}));

vi.mock('../../src/modules/resources/consumption.service.js', () => ({
  rebuildConsumptionsForBooking: rebuildConsumptionsForBookingMock
}));

import { updateBooking } from '../../src/dashboard/repository/bookings.js';

const bookingId = '11111111-1111-1111-1111-111111111111';
const clientId = '22222222-2222-2222-2222-222222222222';
const knownLocationId = '33333333-3333-3333-3333-333333333333';
const noLocationId = '44444444-4444-4444-4444-444444444444';
const unknownRegiondoLocationId = '55555555-5555-5555-5555-555555555555';

const createCurrentBookingRow = (overrides: Record<string, unknown> = {}) => ({
  booking_id: bookingId,
  client_id: clientId,
  location_id: knownLocationId,
  status: 'confirmed',
  guest_count: 2,
  total_amount: '40.00',
  paid_amount: '20.00',
  dt_from: '2026-05-10T16:00:00.000Z',
  dt_to: '2026-05-10T18:00:00.000Z',
  source: 'manual',
  regiondo_booking_id: null,
  regiondo_order_number: null,
  regiondo_raw: null,
  updated_at: '2026-05-01T10:00:00.000Z',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: null,
  phone_number: null,
  ops_status: 'normal',
  ops_notes: '',
  last_provider_edit_error: null,
  location_override: null,
  ...overrides
});

const createFinalBookingRow = (overrides: Record<string, unknown> = {}) => ({
  id: bookingId,
  status: 'confirmed',
  guest_count: 2,
  total_amount: '40.00',
  paid_amount: '20.00',
  dt_from: '2026-05-10T16:00:00.000Z',
  dt_to: '2026-05-10T18:00:00.000Z',
  source: 'manual',
  updated_at: '2026-05-01T10:01:00.000Z',
  booking_raw: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: null,
  phone_number: null,
  product_title: 'Booking',
  regiondo_booking_id: null,
  regiondo_order_number: null,
  client_regiondo_customer_id: null,
  location_id: noLocationId,
  location_title: 'No location',
  location_regiondo_location_id: SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  location_override: 'none',
  last_provider_edit_error: null,
  ops_status: 'normal',
  ops_notes: '',
  ...overrides
});

const syncRow = {
  booking_id: bookingId,
  regiondo_booking_id: null,
  regiondo_order_number: null,
  regiondo_snapshot_generated_at: null,
  last_provider_edit_error: null,
  latest_event_id: null,
  latest_event_status: null,
  latest_event_action_type: null,
  latest_event_channel: null,
  latest_event_created_at: null,
  latest_event_available_at: null,
  latest_event_processed_at: null,
  latest_event_provider_snapshot_at: null,
  latest_event_attempt_count: 0,
  latest_event_last_error: null
};

function setupRepositoryQueries(input: {
  currentRow: Record<string, unknown>;
  finalRow?: Record<string, unknown>;
  locationRows?: Record<string, Record<string, unknown>>;
}) {
  const finalRow = input.finalRow ?? createFinalBookingRow();
  const locationRows = {
    [knownLocationId]: {
      location_id: knownLocationId,
      title: 'Berlin Mitte',
      regiondo_location_id: 'regiondo-location-1'
    },
    [noLocationId]: {
      location_id: noLocationId,
      title: 'No location',
      regiondo_location_id: SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID
    },
    [unknownRegiondoLocationId]: {
      location_id: unknownRegiondoLocationId,
      title: 'Unknown Regiondo location',
      regiondo_location_id: SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
    },
    ...input.locationRows
  };

  clientQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('FOR UPDATE OF b, c')) {
      return { rowCount: 1, rows: [input.currentRow] };
    }

    if (sql.includes('FROM booking_products bp')) {
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('FROM clients') && sql.includes('client_id <>')) {
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('INSERT INTO locations') && sql.includes('No location')) {
      return { rowCount: 1, rows: [locationRows[noLocationId]] };
    }

    if (sql.includes('FROM locations') && sql.includes('WHERE location_id = $1')) {
      const location = locationRows[String(values?.[0])];
      return location ? { rowCount: 1, rows: [location] } : { rowCount: 0, rows: [] };
    }

    if (sql.includes('UPDATE clients') || sql.includes('UPDATE bookings') || sql.includes('INSERT INTO booking_admin_metadata')) {
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  });

  poolQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('LEFT JOIN locations location')) {
      return { rowCount: 1, rows: [finalRow] };
    }

    if (sql.includes('FROM booking_products bp')) {
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('LEFT JOIN LATERAL')) {
      return { rowCount: 1, rows: [syncRow] };
    }

    return { rowCount: 0, rows: [] };
  });
}

describe('dashboard booking update location overrides', () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    hydrateBookingOrderMock.mockReset();
    normalizeRegiondoBookingImportMock.mockReset();
    poolQueryMock.mockReset();
    rebuildConsumptionsForBookingMock.mockReset();
    releaseMock.mockReset();
    updateBookingMock.mockReset();
    upsertNormalizedRegiondoBookingMock.mockReset();
  });

  it('stores no location for manual bookings through the shared placeholder', async () => {
    setupRepositoryQueries({ currentRow: createCurrentBookingRow() });

    const booking = await updateBooking(bookingId, { locationId: null });

    expect(updateBookingMock).not.toHaveBeenCalled();
    expect(booking.locationDataStatus).toBe('none');
    expect(booking.locationId).toBeNull();

    const bookingLocationUpdate = clientQueryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE bookings') && sql.includes('SET location_id = $2')
    );
    expect(bookingLocationUpdate?.[1]?.[1]).toBe(noLocationId);

    const metadataUpsert = clientQueryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO booking_admin_metadata') && sql.includes('location_override')
    );
    expect(metadataUpsert?.[1]).toEqual([bookingId, 'normal', '', null, 'none']);
  });

  it('does not call Regiondo when a Regiondo booking is only cleared to no location', async () => {
    setupRepositoryQueries({
      currentRow: createCurrentBookingRow({
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      }),
      finalRow: createFinalBookingRow({
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      })
    });

    await updateBooking(bookingId, { locationId: null });

    expect(updateBookingMock).not.toHaveBeenCalled();
    expect(hydrateBookingOrderMock).not.toHaveBeenCalled();
    expect(upsertNormalizedRegiondoBookingMock).not.toHaveBeenCalled();
  });

  it('pushes supported Regiondo edits but keeps no location local', async () => {
    setupRepositoryQueries({
      currentRow: createCurrentBookingRow({
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      }),
      finalRow: createFinalBookingRow({
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      })
    });
    updateBookingMock.mockResolvedValue({ result: 'ok' });
    hydrateBookingOrderMock.mockResolvedValue({ purchaseData: {}, supplierBookings: [] });
    normalizeRegiondoBookingImportMock.mockReturnValue({ bookingKey: 'booking-key-1' });
    upsertNormalizedRegiondoBookingMock.mockResolvedValue({ bookingId });

    await updateBooking(bookingId, {
      contact: {
        email: 'family@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneNumber: '+491234567'
      },
      locationId: null
    });

    expect(updateBookingMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        locationId: expect.anything()
      })
    );
    expect(updateBookingMock).toHaveBeenCalledWith(expect.objectContaining({ bookingKey: 'booking-key-1' }));
    expect(upsertNormalizedRegiondoBookingMock).toHaveBeenCalledTimes(1);

    const localLocationUpdates = clientQueryMock.mock.calls.filter(
      ([sql]: [string]) => sql.includes('UPDATE bookings') && sql.includes('SET location_id = $2')
    );
    expect(localLocationUpdates.at(-1)?.[1]?.[1]).toBe(noLocationId);
  });

  it('clears the local override when a Regiondo booking is moved back to a provider location', async () => {
    setupRepositoryQueries({
      currentRow: createCurrentBookingRow({
        location_id: noLocationId,
        location_override: 'none',
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      }),
      finalRow: createFinalBookingRow({
        location_id: knownLocationId,
        location_title: 'Berlin Mitte',
        location_regiondo_location_id: 'regiondo-location-1',
        location_override: null,
        source: 'regiondo',
        regiondo_booking_id: 'booking-key-1',
        regiondo_order_number: 'order-1'
      })
    });
    updateBookingMock.mockResolvedValue({ result: 'ok' });
    hydrateBookingOrderMock.mockResolvedValue({ purchaseData: {}, supplierBookings: [] });
    normalizeRegiondoBookingImportMock.mockReturnValue({ bookingKey: 'booking-key-1' });
    upsertNormalizedRegiondoBookingMock.mockResolvedValue({ bookingId });

    await updateBooking(bookingId, { locationId: knownLocationId });

    expect(updateBookingMock).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'regiondo-location-1' }));

    const metadataUpsert = clientQueryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO booking_admin_metadata') && sql.includes('location_override')
    );
    expect(metadataUpsert?.[1]).toEqual([bookingId, 'normal', '', null, null]);
  });

  it('rejects direct system placeholder ids in booking updates', async () => {
    setupRepositoryQueries({
      currentRow: createCurrentBookingRow(),
      finalRow: createFinalBookingRow()
    });

    await expect(updateBooking(bookingId, { locationId: noLocationId })).rejects.toThrow(
      /System location placeholders must be selected through the No location option/
    );

    expect(updateBookingMock).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls.some(([sql]: [string]) => sql === 'ROLLBACK')).toBe(true);
  });
});
