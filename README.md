# Spielkind Regiondo Sync (TypeScript + Render)

TypeScript service with:
- Regiondo booking webhook endpoint (`POST /webhooks/regiondo/bookings`)
- Daily product/variant/option synchronization job
- PostgreSQL upserts based on existing SQL table files
- Render-ready deployment via `render.yaml`

## Setup

```bash
cp .env.example .env
npm ci
npm run migrate
npm run dev
```

## Docker

Build:

```bash
docker build -t spielkind-regiondo-sync .
```

Run:

```bash
docker run --rm -p 3000:3000 --env-file .env spielkind-regiondo-sync
```

## Regiondo webhook setup (bookings)

Use these exact steps after your Render service is live:

1. **Set env vars in Render**
   - `REGIONDO_PUBLIC_KEY`, `REGIONDO_PRIVATE_KEY`, `REGIONDO_BASE_URL`
   - `DATABASE_URL` (linked from Render PostgreSQL)
   - Optional: `REGIONDO_WEBHOOK_SECRET` (only if your Regiondo webhook can sign payloads)
   - Optional: change `WEBHOOK_BOOKINGS_PATH` to a long random path (recommended for extra protection)
   - Recommended for Regiondo webhook auth:
     - `WEBHOOK_AUTH_HEADER_NAME=x-webhook-token`
     - `WEBHOOK_AUTH_HEADER_VALUE=<long-random-token>`
     - Optional fallback if Regiondo header validation is unreliable:
       - `WEBHOOK_AUTH_QUERY_TOKEN=<long-random-token>`

2. **Run DB migrations once**
   - Locally against Render DB:
     ```bash
     npm run migrate
     ```

3. **Create webhook URL**
   - URL format:
     ```text
     https://<your-render-service>.onrender.com<WEBHOOK_BOOKINGS_PATH>
     ```
   - Example:
     ```text
     https://spielkind-regiondo-sync.onrender.com/webhooks/regiondo/bookings
     ```

4. **Configure in Regiondo**
   - Open Regiondo admin → webhook/event settings.
   - Add event for **booking created/updated/cancelled** (naming depends on Regiondo UI).
   - Set method to `POST`.
   - Set target URL to the URL from step 3.
   - Content type should be JSON.
   - Add custom header in Regiondo:
     - Header **Key** = value of `WEBHOOK_AUTH_HEADER_NAME` (example: `x-webhook-token`)
     - Header **Value** = value of `WEBHOOK_AUTH_HEADER_VALUE` (the same long random token)
   - Alternative auth: append `?token=<WEBHOOK_AUTH_QUERY_TOKEN>` to webhook URL.
   - If Regiondo supports signing shared secrets, use the same secret as `REGIONDO_WEBHOOK_SECRET`.

5. **Test end-to-end**
   - In Regiondo, trigger webhook test (or create/update/cancel a booking).
   - Check Render logs for HTTP `202`.
   - Verify DB rows in `bookings`, `booking_products`, and `sync_log`.

## Manual product sync (first import)

Run this once right after deploying/migrating, then rely on the daily cron:

```bash
npm run sync:products
```

## Environment Variables

See `.env.example`.

Required:
- `DATABASE_URL`
- `REGIONDO_PUBLIC_KEY`
- `REGIONDO_PRIVATE_KEY`
- `REGIONDO_BASE_URL`

Optional:
- `REGIONDO_WEBHOOK_SECRET` (if webhook signature validation should be enforced)
- `WEBHOOK_BOOKINGS_PATH` (defaults to `/webhooks/regiondo/bookings`)
- `WEBHOOK_AUTH_HEADER_NAME` + `WEBHOOK_AUTH_HEADER_VALUE` (recommended static webhook auth)
- `WEBHOOK_AUTH_QUERY_TOKEN` (optional URL-token auth fallback)
- `PRODUCT_SYNC_CRON` (default daily at 03:00 UTC)

## Flow

### Booking webhook
1. Receive webhook payload from Regiondo.
2. Optionally verify HMAC signature.
3. Upsert booking and `booking_products`.
4. Write status to `sync_log`.

### Daily product sync
1. Cron triggers once per day.
2. Fetch `/products` from Regiondo.
3. Upsert `products` table.
4. Refresh related `product_variants` + `product_options` tables.
5. Write status to `sync_log`.

## Notes / Open Questions

- This implementation assumes Regiondo booking payloads include enough fields for status, time and product references.
- If Regiondo webhook signatures use a different header or format than `x-regiondo-signature` + raw-hex HMAC, adapt `verifyWebhookSignature`.
- If products/variants/options come from separate Regiondo endpoints in your account, update `syncProductsAndVariants` accordingly.

## Troubleshooting (Render deploy)

### `ECONNREFUSED 127.0.0.1:5432` or `::1:5432`

This means `DATABASE_URL` is pointing to localhost (from local dev), not your Render Postgres.

Fix:
1. In Render, open your web service → **Environment**.
2. Set `DATABASE_URL` to the Render Postgres connection string (or link it via Blueprint `fromDatabase`).
3. Ensure `NODE_ENV=production`.
4. Redeploy.
