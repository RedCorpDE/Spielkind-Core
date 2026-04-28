import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID, SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID } from '../../sync/mappers.js';
import type { BookingRow } from './core.js';
import { mapBookingRow, requireIsoString, toIsoString } from './core.js';

test('toIsoString returns null for missing or invalid values', () => {
  assert.equal(toIsoString(null), null);
  assert.equal(toIsoString(undefined), null);
  assert.equal(toIsoString('not-a-date'), null);
});

test('requireIsoString throws for missing or invalid values', () => {
  assert.throws(() => requireIsoString(undefined, 'example.field'), /example\.field is missing or invalid\./);
  assert.throws(() => requireIsoString('not-a-date', 'example.field'), /example\.field is missing or invalid\./);
});

test('mapBookingRow surfaces placeholder provider data explicitly', () => {
  const booking = mapBookingRow({
    id: 'booking-1',
    status: 'pending',
    guest_count: 2,
    total_amount: '20.00',
    paid_amount: '0.00',
    dt_from: '2026-04-27T10:00:00.000Z',
    updated_at: '2026-04-27T11:00:00.000Z',
    booking_raw: null,
    first_name: null,
    last_name: null,
    email: null,
    product_title: null,
    regiondo_booking_id: 'regiondo-booking-1',
    regiondo_order_number: 'order-1',
    client_regiondo_customer_id: SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
    location_id: 'location-1',
    location_title: 'Unknown Location',
    location_regiondo_location_id: SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID,
    ops_status: 'normal',
    ops_notes: ''
  } satisfies BookingRow);

  assert.equal(booking.customerDataStatus, 'unknown');
  assert.equal(booking.locationDataStatus, 'unknown');
  assert.equal(booking.familyName, 'Unknown customer');
  assert.equal(booking.childName, 'Unknown child');
  assert.equal(booking.locationId, null);
  assert.equal(booking.locationTitle, 'Unknown Regiondo location');
});
