# Sprint 1 booking stabilization

## State ownership

Core is the only authority for booking validity, availability, price, booking state, and payment state. Dashboard, App, and WordPress submit actions and selections; they do not calculate or persist authoritative state.

Booking transitions are implemented in `booking-lifecycle.service.ts`. Every accepted change locks the booking row, validates the transition, updates the booking, appends `booking_state_events`, and emits the existing transactional outbox event.

```text
draft -> held -> payment_pending -> confirmed -> checked_in -> in_progress -> completed
   |       |            |              |             |
   +-------+------------+--------------+-------------+-> cancelled
                        |              +----------------> no_show
                        +-> payment_failed -> payment_pending
                        +-> expired
```

Legacy Regiondo values are normalized at the domain boundary (`pending` and `processing` to `payment_pending`; `canceled` and `rejected` to `cancelled`). Provider imports remain behind the Regiondo adapter and provider mapping; no Regiondo identifiers or routes were removed.

Payment state is independent and implemented in `payment-lifecycle.service.ts`:

```text
unpaid -> processing -> paid -> refund_pending -> partially_refunded -> refunded
   |          |          |            |                    |
   +----------+-> failed +------------+-> refund_failed ----+
```

Intentional combinations include `confirmed + unpaid` for authorized Dashboard pay-later creation, `cancelled + paid` while an external refund is pending, and `completed + refunded` for a post-visit refund. `payment_failed + paid` and `confirmed + failed` are rejected by domain validation.

## Holds and concurrency

An active hold owns one or more rows in `reservation_hold_allocations`. Hold creation runs at `SERIALIZABLE`, locks required Resource rows in UUID order, and rechecks overlapping Consumption plus active, unexpired Hold usage. The availability query also filters on `expires_at > now()`, so delayed cleanup cannot leave expired inventory blocked.

Payment confirmation runs at `SERIALIZABLE` and locks the Payment, Booking, Hold, and Resource rows. In one transaction it verifies provider amount/currency, rechecks capacity, creates Consumption rows, consumes the Hold, advances payment state, confirms the Booking, and writes outbox/state events. A capacity conflict after a late payment becomes `change_requested` for manual resolution and never creates an overbooking.

## Idempotency

- App hold, booking, and payment operations reuse one checkout-attempt identifier across retries.
- WordPress keeps one attempt key while a checkout selection is unchanged.
- `bookings.idempotency_key`, `payments.idempotency_key`, and `reservation_holds.idempotency_key` are durable unique keys.
- `web_checkout_idempotency` records `in_progress`, `completed`, or `failed`. Failed and stale process-interrupted attempts can resume; Stripe calls reuse the same provider idempotency key.
- Stripe webhook event IDs are unique in `integration_events`. Duplicate deliveries return success without enqueueing a second domain operation.

In-memory values are not the authority for any idempotency decision.

## Error contract

`/api/web/*` uses the stable nested envelope:

```json
{
  "error": {
    "code": "HOLD_EXPIRED",
    "message": "The reservation hold has expired.",
    "details": {}
  }
}
```

Admin and Client routes retain the legacy `ok` and string `error` fields during consumer migration, while also returning stable `code`, `message`, and `errorDetails: { code, message }` fields. Their canonical schemas and error enum are published by `GET /openapi.json`. Internal stack traces and database messages are never returned for unhandled errors.

Important booking codes include `AVAILABILITY_CHANGED`, `PRICE_CHANGED`, `INVALID_VARIANT`, `INVALID_OPTION`, `SALES_CLOSED`, `RESOURCE_UNAVAILABLE`, `HOLD_EXPIRED`, `CHECKOUT_EXPIRED`, `CHECKOUT_ALREADY_COMPLETED`, `INVALID_BOOKING_TRANSITION`, `INVALID_PAYMENT_TRANSITION`, `PAYMENT_FAILED`, and `PAYMENT_REQUIRES_ACTION`.

## Database protection

Migration `537_booking_stabilization_contract.sql`:

- extends the compatible Booking status constraint with `in_progress`;
- creates append-only Booking and Payment state event tables;
- gives web checkout idempotency an explicit recoverable lifecycle;
- adds active-hold, checkout-expiry, booking schedule, payment-provider, and state-event indexes; and
- adds forward-safe constraints for Booking amounts, participants, schedules, and checkout expiry.

Financial and booking history continues to use restrictive foreign keys. The migration does not cascade-delete history or rewrite provider data.

## Deterministic fixtures and tests

`tests/fixtures/sprint1-booking-fixtures.ts` defines one deterministic location with PC Room 1/2 (five PCs each), Bedroom 1/2 (five beds each), LAN Flat, VR Area (six headsets and three projectors), Console Room, and a fixed-date event.

Run the standard suite:

```powershell
npm test
```

Run real PostgreSQL concurrency tests against an isolated, fully migrated database (the command refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`):

```powershell
$env:TEST_DATABASE_URL = 'postgresql://.../spielkind_sprint1_test'
npm run test:integration
```

The concurrency suite launches simultaneous transactions. It proves that only one request can acquire the final capacity and that duplicate concurrent payment confirmations produce one Booking, one Payment relationship, and one Consumption.

## API and consumer compatibility

- `GET /openapi.json` documents the implemented booking surfaces and authentication schemes for `/api/client`, `/api/web`, and `/api/admin`.
- Dashboard status changes remain action endpoints (`cancel`, `no-show`); generic Booking PATCH does not accept status.
- App parses both legacy and structured errors and preserves checkout idempotency keys across retry.
- WordPress keeps the Core service token server-side, maps the stabilized error codes, and reuses its checkout key after network/payment initialization failures.
- Regiondo provider mapping, webhooks, sync jobs, legacy identifiers, and provider references remain intact.
