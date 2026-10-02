import type { Pool } from 'pg';

export const sprint1FixtureIds = {
  location: '71000000-0000-4000-8000-000000000001',
  client: '71000000-0000-4000-8000-000000000002',
  products: {
    pc: '71000000-0000-4000-8000-000000000101',
    lanFlat: '71000000-0000-4000-8000-000000000102',
    sleeping: '71000000-0000-4000-8000-000000000103',
    vr: '71000000-0000-4000-8000-000000000104',
    console: '71000000-0000-4000-8000-000000000105',
    fixedEvent: '71000000-0000-4000-8000-000000000106'
  },
  offerings: {
    pc: '71000000-0000-4000-8000-000000000201',
    lanFlat: '71000000-0000-4000-8000-000000000202',
    sleeping: '71000000-0000-4000-8000-000000000203',
    vr: '71000000-0000-4000-8000-000000000204',
    console: '71000000-0000-4000-8000-000000000205',
    fixedEvent: '71000000-0000-4000-8000-000000000206'
  },
  resources: {
    pcRoom1: '71000000-0000-4000-8000-000000000301',
    pcRoom2: '71000000-0000-4000-8000-000000000302',
    bedroom1: '71000000-0000-4000-8000-000000000303',
    bedroom2: '71000000-0000-4000-8000-000000000304',
    lanFlat: '71000000-0000-4000-8000-000000000305',
    vrHeadsets: '71000000-0000-4000-8000-000000000306',
    vrProjectors: '71000000-0000-4000-8000-000000000307',
    consoleRoom: '71000000-0000-4000-8000-000000000308',
    eventCapacity: '71000000-0000-4000-8000-000000000309'
  }
} as const;

export const sprint1BusinessCases = [
  { name: 'PC Room 1', kind: 'pc', capacity: 5 },
  { name: 'PC Room 2', kind: 'pc', capacity: 5 },
  { name: 'Bedroom 1', kind: 'sleeping_room', capacity: 5 },
  { name: 'Bedroom 2', kind: 'sleeping_room', capacity: 5 },
  { name: 'LAN Flat', kind: 'room', capacity: 1 },
  { name: 'VR Area headsets', kind: 'vr_headset', capacity: 6 },
  { name: 'VR Area projectors', kind: 'projector', capacity: 3 },
  { name: 'Console Room', kind: 'console_station', capacity: 4 },
  { name: 'Fixed-date event', kind: 'area', capacity: 20 }
] as const;

export async function resetSprint1Fixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM booking_state_events WHERE booking_id IN (SELECT booking_id FROM bookings WHERE client_id = $1)`,
    [sprint1FixtureIds.client]
  );
  await pool.query(
    `DELETE FROM payment_state_events WHERE booking_id IN (SELECT booking_id FROM bookings WHERE client_id = $1)`,
    [sprint1FixtureIds.client]
  );
  await pool.query(`DELETE FROM bookings WHERE client_id = $1`, [sprint1FixtureIds.client]);
  await pool.query(`DELETE FROM reservation_holds WHERE location_id = $1`, [sprint1FixtureIds.location]);
  await pool.query(`DELETE FROM products WHERE product_id = ANY($1::uuid[])`, [Object.values(sprint1FixtureIds.products)]);
  await pool.query(`DELETE FROM resources WHERE resource_id = ANY($1::uuid[])`, [Object.values(sprint1FixtureIds.resources)]);
  await pool.query(`DELETE FROM clients WHERE client_id = $1`, [sprint1FixtureIds.client]);
  await pool.query(`DELETE FROM locations WHERE location_id = $1`, [sprint1FixtureIds.location]);
}

export async function seedSprint1Fixtures(pool: Pool): Promise<void> {
  await resetSprint1Fixtures(pool);
  await pool.query(
    `INSERT INTO locations (location_id, title, description)
     VALUES ($1, 'Sprint 1 Test Location', 'Deterministic booking-engine integration fixture')`,
    [sprint1FixtureIds.location]
  );
  await pool.query(
    `INSERT INTO clients (client_id, first_name, last_name, email)
     VALUES ($1, 'Sprint', 'Fixture', 'sprint1-fixture@example.test')`,
    [sprint1FixtureIds.client]
  );

  for (const [index, resource] of sprint1BusinessCases.entries()) {
    await pool.query(
      `INSERT INTO resources (resource_id, location_id, type, capacity_available, title, operational_status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [Object.values(sprint1FixtureIds.resources)[index], sprint1FixtureIds.location, resource.kind, resource.capacity, resource.name]
    );
  }

  const products = [
    [sprint1FixtureIds.products.pc, sprint1FixtureIds.offerings.pc, 'Ordinary PC booking', 1500, 'start_duration'],
    [sprint1FixtureIds.products.lanFlat, sprint1FixtureIds.offerings.lanFlat, 'LAN Flat', 12000, 'date_range'],
    [sprint1FixtureIds.products.sleeping, sprint1FixtureIds.offerings.sleeping, 'Sleeping room', 4500, 'date_range'],
    [sprint1FixtureIds.products.vr, sprint1FixtureIds.offerings.vr, 'VR booking', 3000, 'start_duration'],
    [sprint1FixtureIds.products.console, sprint1FixtureIds.offerings.console, 'Console booking', 2500, 'start_duration'],
    [sprint1FixtureIds.products.fixedEvent, sprint1FixtureIds.offerings.fixedEvent, 'Fixed-date event', 5000, 'fixed_duration']
  ] as const;
  for (const [productId, offeringId, title, priceMinor, mode] of products) {
    await pool.query(
      `INSERT INTO products (product_id, title, base_amount, booking_provider, price_minor, currency, vat_basis_points)
       VALUES ($1, $2, $3, 'core', $4, 'EUR', 1900)`,
      [productId, title, priceMinor / 100, priceMinor]
    );
    await pool.query(
      `INSERT INTO location_products (
         location_id, product_id, product_offering_id, enabled, booking_provider,
         time_selection_mode, min_participants, max_participants, min_duration_minutes,
         max_duration_minutes, duration_step_minutes, default_duration_minutes
       ) VALUES ($1, $2, $3, true, 'core', $4, 1, 20, 60, 1440, 30, 120)`,
      [sprint1FixtureIds.location, productId, offeringId, mode]
    );
  }

  const requirements = [
    [sprint1FixtureIds.offerings.pc, sprint1FixtureIds.resources.pcRoom1, 1, 'per_quantity'],
    [sprint1FixtureIds.offerings.lanFlat, sprint1FixtureIds.resources.lanFlat, 1, 'per_booking'],
    [sprint1FixtureIds.offerings.sleeping, sprint1FixtureIds.resources.bedroom1, 1, 'per_quantity'],
    [sprint1FixtureIds.offerings.vr, sprint1FixtureIds.resources.vrHeadsets, 1, 'per_quantity'],
    [sprint1FixtureIds.offerings.vr, sprint1FixtureIds.resources.vrProjectors, 1, 'per_booking'],
    [sprint1FixtureIds.offerings.console, sprint1FixtureIds.resources.consoleRoom, 1, 'per_booking'],
    [sprint1FixtureIds.offerings.fixedEvent, sprint1FixtureIds.resources.eventCapacity, 1, 'per_quantity']
  ] as const;
  for (const [offeringId, resourceId, quantity, scalingMode] of requirements) {
    await pool.query(
      `INSERT INTO product_offering_resources (product_offering_id, resource_id, quantity, scaling_mode)
       VALUES ($1, $2, $3, $4)`,
      [offeringId, resourceId, quantity, scalingMode]
    );
  }
}
