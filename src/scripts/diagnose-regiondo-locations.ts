import { pool } from '../db/pool.js';
import { discoverRegiondoLocationFields } from '../modules/regiondo/regiondo-location-diagnostics.js';

async function run(): Promise<void> {
  const [bookings, products] = await Promise.all([
    pool.query<{ regiondo_raw: unknown }>(
      `SELECT regiondo_raw
       FROM bookings
       WHERE source = 'regiondo' AND regiondo_raw IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 100`
    ),
    pool.query<{ regiondo_raw: unknown }>(
      `SELECT regiondo_raw
       FROM products
       WHERE regiondo_product_id IS NOT NULL AND regiondo_raw IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 200`
    )
  ]);

  const fields = discoverRegiondoLocationFields([
    ...bookings.rows.map((row) => ({ raw: row.regiondo_raw, source: 'booking' as const })),
    ...products.rows.map((row) => ({ raw: row.regiondo_raw, source: 'product' as const }))
  ]);

  process.stdout.write(`${JSON.stringify({ fields, inspected: { bookings: bookings.rowCount, products: products.rowCount } }, null, 2)}\n`);
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown diagnostic failure.';
    process.stderr.write(`Regiondo location diagnostics failed: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
