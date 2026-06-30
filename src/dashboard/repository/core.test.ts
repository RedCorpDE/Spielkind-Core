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
    dt_to: '2026-04-27T12:00:00.000Z',
    source: 'regiondo',
    updated_at: '2026-04-27T11:00:00.000Z',
    booking_raw: null,
    first_name: null,
    last_name: null,
    email: null,
    phone_number: null,
    product_title: null,
    regiondo_booking_id: 'regiondo-booking-1',
    regiondo_order_number: 'order-1',
    client_regiondo_customer_id: SHARED_REGIONDO_PLACEHOLDER_CUSTOMER_ID,
    location_id: 'location-1',
    location_title: 'Unknown Location',
    location_regiondo_location_id: SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID,
    last_provider_edit_error: null,
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

test('mapBookingRow surfaces manual task payload details', () => {
  const booking = mapBookingRow({
    id: 'booking-2',
    status: 'confirmed',
    guest_count: 4,
    total_amount: '80.00',
    paid_amount: '0.00',
    dt_from: '2026-05-05T10:00:00.000Z',
    dt_to: '2026-05-05T12:00:00.000Z',
    source: 'manual',
    updated_at: '2026-05-05T10:30:00.000Z',
    booking_raw: {
      source: 'manual_task',
      notes: 'Called client and confirmed the slot.',
      manual: {
        contact: {
          email: 'lina@example.com',
          firstName: 'Lina',
          lastName: 'Muster',
          phoneNumber: '+49 30 123456'
        },
        regiondoSelections: [
          {
            id: 'selection-1',
            productTitle: 'VR Party',
            quantity: 1
          }
        ]
      }
    },
    first_name: 'Lina',
    last_name: 'Muster',
    email: 'lina@example.com',
    phone_number: '+49 30 123456',
    product_title: null,
    regiondo_booking_id: null,
    regiondo_order_number: null,
    client_regiondo_customer_id: null,
    location_id: 'location-2',
    location_title: 'Berlin Mitte',
    location_regiondo_location_id: 'manual-location',
    last_provider_edit_error: null,
    ops_status: 'normal',
    ops_notes: ''
  } satisfies BookingRow);

  assert.equal(booking.familyName, 'Muster');
  assert.equal(booking.childName, 'Lina');
  assert.equal(booking.source, 'Manual task');
  assert.equal(booking.specialRequirements, 'Called client and confirmed the slot.');
  assert.equal(booking.experience, 'VR Party');
});
