// Set required environment variables before any module that calls config.ts is imported.
// config.ts calls process.exit(1) when validation fails, so these must be in place first.
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
process.env['DATABASE_SSL'] = 'false';
process.env['REGIONDO_PUBLIC_KEY'] = 'test-public-key';
process.env['REGIONDO_PRIVATE_KEY'] = 'test-private-key';
process.env['REGIONDO_BASE_URL'] = 'https://api.regiondo.com/v1';
process.env['REGIONDO_LANGUAGE'] = 'de-DE';
process.env['PRODUCT_SYNC_CRON'] = '0 3 * * *';
