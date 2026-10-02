import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { seedSprint1Fixtures, resetSprint1Fixtures, sprint1FixtureIds } from '../fixtures/sprint1-booking-fixtures.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mainDatabaseUrl = process.env.DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;

const suite = describe.skipIf(!testDatabaseUrl || testDatabaseUrl === mainDatabaseUrl);

suite('booking concurrency (PostgreSQL)', () => {
  let database: Pool;
  let createReservationHold: typeof import('../../src/modules/availability/reservation-hold.service.js').createReservationHold;
  let confirmStripePayment: typeof import('../../src/modules/payments/payment-confirmation.service.js').confirmStripePayment;
  let appPool: typeof import('../../src/db/pool.js').pool;

  beforeAll(async () => {
    database = new Pool({ connectionString: testDatabaseUrl });
    await seedSprint1Fixtures(database);
    ({ createReservationHold } = await import('../../src/modules/availability/reservation-hold.service.js'));
    ({ confirmStripePayment } = await import('../../src/modules/payments/payment-confirmation.service.js'));
    ({ pool: appPool } = await import('../../src/db/pool.js'));
  });

  afterAll(async () => {
    if (database) await resetSprint1Fixtures(database);
    if (appPool) await appPool.end();
    if (database) await database.end();
  });

  it('allows only one concurrent hold for the final capacity', async () => {
    const startsAt = '2035-10-10T10:00:00.000Z';
    const endsAt = '2035-10-10T12:00:00.000Z';
    const expiresAt = '2035-10-10T09:59:00.000Z';
    const input = {
      clientId: sprint1FixtureIds.client,
      locationId: sprint1FixtureIds.location,
      productId: sprint1FixtureIds.products.pc,
      productOfferingId: sprint1FixtureIds.offerings.pc,
      quantity: 5,
      startsAt,
      endsAt,
      expiresAt
    };
    const settled = await Promise.allSettled([
      createReservationHold({ ...input, idempotencyKey: 'sprint1-concurrent-a' }),
      createReservationHold({ ...input, idempotencyKey: 'sprint1-concurrent-b' })
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const count = await database.query<{ count: string }>(
      `SELECT COUNT(*) count FROM reservation_holds
       WHERE idempotency_key IN ('sprint1-concurrent-a', 'sprint1-concurrent-b') AND status = 'active'`
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('confirms one booking and one consumption under concurrent duplicate confirmation', async () => {
    const bookingId = '71000000-0000-4000-8000-000000000401';
    const holdId = '71000000-0000-4000-8000-000000000402';
    const paymentId = '71000000-0000-4000-8000-000000000403';
    await database.query(
      `INSERT INTO bookings (
         booking_id, client_id, location_id, product_offering_id, status, payment_status,
         guest_count, total_amount, paid_amount, dt_from, dt_to, source, booking_provider, currency, idempotency_key
       ) VALUES ($1, $2, $3, $4, 'payment_pending', 'processing', 1, 120, 0,
         '2035-11-10T10:00:00Z', '2035-11-10T12:00:00Z', 'app', 'core', 'EUR', 'sprint1-confirm-booking')`,
      [bookingId, sprint1FixtureIds.client, sprint1FixtureIds.location, sprint1FixtureIds.offerings.lanFlat]
    );
    await database.query(
      `INSERT INTO reservation_holds (
         reservation_hold_id, booking_id, client_id, location_id, product_id, product_offering_id,
         quantity, starts_at, ends_at, expires_at, status, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, '2035-11-10T10:00:00Z', '2035-11-10T12:00:00Z',
         '2035-11-10T09:59:00Z', 'active', 'sprint1-confirm-hold')`,
      [holdId, bookingId, sprint1FixtureIds.client, sprint1FixtureIds.location,
        sprint1FixtureIds.products.lanFlat, sprint1FixtureIds.offerings.lanFlat]
    );
    await database.query(
      `INSERT INTO reservation_hold_allocations (reservation_hold_id, resource_id, capacity_used)
       VALUES ($1, $2, 1)`,
      [holdId, sprint1FixtureIds.resources.lanFlat]
    );
    await database.query(
      `INSERT INTO payments (
         payment_id, booking_id, amount, type, provider, status, amount_minor, currency,
         provider_payment_id, provider_checkout_id, idempotency_key
       ) VALUES ($1, $2, 120, 'card', 'stripe', 'processing', 12000, 'EUR', 'pi_sprint1', 'cs_sprint1', 'sprint1-payment')`,
      [paymentId, bookingId]
    );

    const input = {
      bookingId, providerCheckoutId: 'cs_sprint1', providerPaymentId: 'pi_sprint1',
      amountMinor: 12000, currency: 'EUR', externalEventId: 'evt_sprint1',
      eventType: 'checkout.session.completed'
    };
    const results = await Promise.all([confirmStripePayment(input), confirmStripePayment(input)]);
    expect(results.map((result) => result.status).sort()).toEqual(['already_confirmed', 'confirmed']);
    const state = await database.query<{ bookings: string; payments: string; consumptions: string }>(
      `SELECT
        (SELECT COUNT(*) FROM bookings WHERE booking_id = $1) bookings,
        (SELECT COUNT(*) FROM payments WHERE booking_id = $1) payments,
        (SELECT COUNT(*) FROM consumptions WHERE booking_id = $1) consumptions`,
      [bookingId]
    );
    expect(Number(state.rows[0].bookings)).toBe(1);
    expect(Number(state.rows[0].payments)).toBe(1);
    expect(Number(state.rows[0].consumptions)).toBe(1);
  });
});
