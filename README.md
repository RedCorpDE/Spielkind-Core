# Spielkind Core

Core is a TypeScript Node.js backend for:
- Regiondo webhook ingestion
- Regiondo catalog sync
- internal resource occupancy via `consumptions`
- reminder delivery dispatch through an external provider webhook
- admin APIs for products, bookings, resources, clients, groups, and reminders

The runtime is built around:
- Fastify
- Zod
- PostgreSQL via `pg`
- Pino
- Vitest
- `node-cron` only as a thin embedded scheduler wrapper

## Structure

Key runtime entrypoints:
- `src/app.ts`
- `src/server.ts`

Core folders:
- `src/config`: env validation and logging
- `src/db`: pool, transactions, advisory locks, migrations
- `src/http`: Fastify route wiring, auth helpers, error handling
- `src/modules`: Regiondo, bookings, resources, reminders, products, clients, groups
- `src/jobs`: reusable job wrappers and job-run tracking
- `src/scripts`: CLI entrypoints for jobs
- `src/scheduler`: embedded scheduler
- `db/migrations`: additive SQL migrations

## Setup

```bash
cp .env.example .env
npm ci
npm run migrate
npm run dev
```

Create an admin user:

```bash
npm run admin:create -- --email admin@example.com --name "Admin User" --password "use-a-long-random-password"
```

## Scripts

```bash
npm run dev
npm run build
npm test
npm run migrate
npm run job:regiondo-webhooks
npm run job:sync-regiondo-catalog
npm run job:dispatch-reminders
npm run job:reconcile-regiondo-bookings
```

## Required Environment

See `.env.example`.

Important variables:
- `DATABASE_URL`
- `PORT`
- `REGIONDO_BASE_URL`
- `REGIONDO_PUBLIC_KEY`
- `REGIONDO_SECRET_KEY`
- `REGIONDO_PRODUCT_SUPPLIER_ID`
- `REMINDER_PROVIDER_WEBHOOK_URL`
- `REMINDER_PROVIDER_SECRET`
- `CRON_SECRET`
- `ENABLE_EMBEDDED_SCHEDULER`

Important operational variables:
- `REGIONDO_WEBHOOK_SECRET`
- `WEBHOOK_AUTH_HEADER_NAME`
- `WEBHOOK_AUTH_HEADER_VALUE`
- `SCHEDULER_TIMEZONE`
- `REGIONDO_CATALOG_SYNC_CRON`
- `REGIONDO_WEBHOOK_CRON`
- `REMINDER_DISPATCH_CRON`
- `DASHBOARD_ALLOWED_ORIGIN`
- `ADMIN_ACCESS_TOKEN_SECRET`

## HTTP Surface

System:
- `GET /healthz`
- `GET /readyz`
- `GET /version`

Regiondo webhook:
- `GET /webhooks/regiondo/bookings`
- `POST /webhooks/regiondo/bookings`

Regiondo booking webhook setup:
- Webhook name: `Spielkind Core Bookings`
- Payload URL: `https://spielkind-core.onrender.com/webhooks/regiondo/bookings`
- Header key: use `WEBHOOK_AUTH_HEADER_NAME` from Render, for example `x-webhook-token`
- Header value: use `WEBHOOK_AUTH_HEADER_VALUE` from Render
- Optional signature secret: set `REGIONDO_WEBHOOK_SECRET` only if Regiondo sends `x-regiondo-signature`

Accepted webhook behavior:
- The POST endpoint stores each incoming booking event in `regiondo_webhook_events`
- Core immediately triggers inbox processing after successful inserts
- The embedded scheduler continues polling as a safety net via `REGIONDO_WEBHOOK_CRON`

Internal jobs:
- `POST /internal/jobs/process-regiondo-webhooks`
- `POST /internal/jobs/sync-regiondo-catalog`
- `POST /internal/jobs/dispatch-reminders`
- `POST /internal/jobs/reconcile-regiondo-bookings`

Admin auth:
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/refresh`
- `POST /api/admin/auth/logout`
- `GET /api/admin/auth/me`

Admin APIs:
- `GET /api/admin/products`
- `GET /api/admin/products/:productId`
- `PATCH /api/admin/products/:productId`
- `POST /api/admin/products/:productId/resources`
- `DELETE /api/admin/products/:productId/resources/:resourceId`
- `GET /api/admin/regiondo/products`
- `POST /api/admin/regiondo/sync-products`
- `GET /api/admin/resources`
- `GET /api/admin/resources/:resourceId`
- `GET /api/admin/availability`
- `GET /api/admin/bookings`
- `GET /api/admin/bookings/:bookingId`
- `PATCH /api/admin/bookings/:bookingId/admin-metadata`
- `POST /api/admin/bookings/:bookingId/rebuild-consumptions`
- `POST /api/admin/bookings/:bookingId/cancel-local`
- `GET /api/admin/clients`
- `GET /api/admin/clients/:clientId`
- `PATCH /api/admin/clients/:clientId`
- `GET /api/admin/client-groups`
- `POST /api/admin/client-groups`
- `PATCH /api/admin/client-groups/:groupId`
- `DELETE /api/admin/client-groups/:groupId`
- `POST /api/admin/client-groups/:groupId/members/:clientId`
- `DELETE /api/admin/client-groups/:groupId/members/:clientId`
- `GET /api/admin/reminder-rules`
- `POST /api/admin/reminder-rules`
- `GET /api/admin/reminder-rules/:ruleId`
- `PATCH /api/admin/reminder-rules/:ruleId`
- `DELETE /api/admin/reminder-rules/:ruleId`
- `GET /api/admin/reminder-deliveries`
- `POST /api/admin/reminder-deliveries/:deliveryId/retry`
- `GET /api/admin/regiondo/sync-summary`
- `GET /api/admin/regiondo/webhook-events`
- `GET /api/admin/regiondo/webhook-events/:eventId`
- `POST /api/admin/regiondo/webhook-events/:eventId/retry`

## Job Model

Business logic lives in reusable job functions and can be invoked from:
- embedded scheduler
- internal authenticated HTTP endpoints
- CLI scripts

Current embedded jobs:
- Regiondo webhook inbox processing
- weekly Regiondo catalog sync for products, variations, and options
- reminder dispatch
- periodic Regiondo reconciliation

Each job uses PostgreSQL advisory locking and records `job_runs`.

The Regiondo catalog sync now defaults to `REGIONDO_CATALOG_SYNC_CRON=0 3 * * 1`, which runs every Monday at 03:00 in `SCHEDULER_TIMEZONE` (default `Europe/Berlin`).

For later external cron jobs, keep using the same internal job handler instead of duplicating logic:
- `POST /internal/jobs/sync-regiondo-catalog`
- Header: `Authorization: Bearer <CRON_SECRET>`

## Database Notes

Do not rewrite applied migrations. Add new ones.

Recent architecture-specific migration:
- `db/migrations/026_core_jobs_reminders_contact_methods.sql`

That migration adds:
- `client_contact_methods`
- `reminder_rules`
- `reminder_deliveries`
- `sync_state`
- `job_runs`

## Deployment

Core is designed for:
1. an always-on Render web service with `ENABLE_EMBEDDED_SCHEDULER=true`
2. a later move to Render Cron Jobs without rewriting business logic

See `render.yaml`.

## Verification

Current verification commands:

```bash
npm run build
npm test
```
