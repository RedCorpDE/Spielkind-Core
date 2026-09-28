import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listBookingsMock, poolQueryMock } = vi.hoisted(() => ({
  listBookingsMock: vi.fn(),
  poolQueryMock: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({
  pool: { connect: vi.fn(), query: poolQueryMock }
}));

vi.mock('../../src/dashboard/repository/bookings.js', () => ({
  listBookings: listBookingsMock
}));

import {
  getAdminClient,
  listAdminClientBookings,
  listAdminClients
} from '../../src/modules/clients/client-admin.repository.js';

const clientId = '11111111-1111-4111-8111-111111111111';

describe('client admin repository', () => {
  beforeEach(() => {
    listBookingsMock.mockReset();
    poolQueryMock.mockReset();
  });

  it('applies search, aggregate filters, sorting, and pagination in one list query', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{
        client_id: clientId,
        first_name: 'Alex',
        last_name: 'Player',
        display_name: 'Alex Player',
        primary_email: 'alex@example.com',
        primary_phone: '+49123',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
        booking_count: '12',
        upcoming_booking_count: '2',
        group_count: '3',
        identity_count: '1',
        email_verified: true,
        last_activity_at: '2026-03-01T00:00:00.000Z',
        total_count: '51'
      }]
    });

    const result = await listAdminClients({
      search: 'Alex',
      hasBookings: true,
      hasAppAccount: true,
      sort: 'bookingCount',
      direction: 'desc',
      page: 2,
      limit: 25
    });

    const [query, values] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('searched_contact.destination ILIKE $1');
    expect(query).toContain('COALESCE(booking_stats.booking_count, 0) > 0');
    expect(query).toContain('COALESCE(auth_stats.identity_count, 0) > 0');
    expect(query).toContain('ORDER BY booking_count DESC');
    expect(values).toEqual(['%Alex%', 25, 25]);
    expect(result).toMatchObject({ page: 2, limit: 25, total: 51, totalPages: 3 });
    expect(result.items[0]).toMatchObject({ bookingCount: 12, appAccountStatus: 'active' });
  });

  it('maps a detail DTO without serializing auth, token, provider-reference, or contact raw fields', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        client_id: clientId,
        first_name: 'Alex',
        last_name: 'Player',
        display_name: 'Alex Player',
        avatar_url: null,
        birthday: null,
        email: 'alex@example.com',
        phone_number: null,
        preferred_contact_type: 'email',
        subscribed_to_newsletter: false,
        regiondo_customer_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
        contact_methods: [{ contactMethodId: 'contact-1', channel: 'email', destination: 'alex@example.com', isEnabled: true, isVerified: true }],
        app_account: { hasAccount: true, emailVerified: true, providers: ['password'], activeSessionCount: 1, lastLoginAt: null, status: 'active' },
        preferences: null,
        groups: [],
        booking_summary: { total: 1, upcoming: 1, past: 0, cancelled: 0 },
        devices: [],
        device_summary: { total: 0, active: 0 },
        last_activity_at: '2026-02-01T00:00:00.000Z',
        password_hash: 'must-never-leave-core',
        refresh_token_hash: 'must-never-leave-core',
        push_token: 'must-never-leave-core',
        provider_ref: 'must-never-leave-core',
        raw_json: { secret: true }
      }]
    });

    const detail = await getAdminClient(clientId);
    const serialized = JSON.stringify(detail);

    expect(detail?.contactMethods[0]).toEqual({
      contactMethodId: 'contact-1',
      channel: 'email',
      destination: 'alex@example.com',
      isEnabled: true,
      isVerified: true
    });
    expect(serialized).not.toMatch(/password_hash|refresh_token_hash|push_token|provider_ref|raw_json|must-never-leave-core/);
  });

  it('reuses the existing booking DTO query for linked client bookings', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] });
    listBookingsMock.mockResolvedValueOnce({ items: [], nextCursor: null });

    await expect(listAdminClientBookings(clientId, { category: 'upcoming', limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null
    });
    expect(listBookingsMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId,
      clientBookingCategory: 'upcoming',
      limit: 10,
      sort: 'bookingDate'
    }));
  });

  it('returns null for bookings when the client does not exist', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(listAdminClientBookings(clientId)).resolves.toBeNull();
    expect(listBookingsMock).not.toHaveBeenCalled();
  });
});
