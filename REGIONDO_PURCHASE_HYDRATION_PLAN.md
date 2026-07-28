# Regiondo Purchase Hydration Plan

## Goal

Make booking creation tolerate Regiondo's eventually consistent purchase snapshots without ever automatically replaying a purchase whose outcome may be unknown.

Preserve the current uncommitted compatibility changes for mislabeled JSON, double-encoded JSON, nested response envelopes, and clearer payload errors.

## 1. Separate safe read retries from purchase submission

Update `src/modules/regiondo/regiondo.client.ts`:

- Add a per-request retry override to `RegiondoRequestOptions`.
- Make retries method-aware: `GET` requests use the existing transport retry policy by default; `POST`, `PUT`, and `DELETE` default to no automatic retries.
- Ensure `purchaseOrder` makes exactly one `POST /checkout/purchase` request.
- Keep ordinary GET retries for transient network failures, timeouts, `408`, `425`, `429`, and `5xx` responses.
- Do not retry authentication failures, permanent `4xx` responses, invalid JSON, or schema errors outside the purchase-hydration flow.

This prevents a timeout after a successful Regiondo purchase from causing the backend to submit a second order.

## 2. Add bounded GET-only purchase polling

Refactor `resolvePurchaseOrderSnapshot` in `src/modules/regiondo/regiondo.client.ts`:

1. Return immediately when the POST already contains a complete purchase snapshot.
2. When the receipt contains `order_number`, poll `GET /checkout/purchase?order_number=...`.
3. When it contains only `order_id`, poll `GET /supplier/bookings?order_ids=...` until an order number appears, then poll the purchase endpoint.
4. Retry within this polling loop when:
   - a safe GET has a transient transport/API failure;
   - supplier bookings are temporarily empty;
   - an HTTP 200 response is valid JSON but not yet a complete purchase snapshot.
5. Stop immediately for authentication failures and permanent `4xx` responses.
6. Give hydration GETs zero inner retries so the polling loop owns one predictable attempt and time budget.
7. Retain the latest useful payload validation details if polling is exhausted.

Add these settings to `src/config/env.ts` and `.env.example`:

```text
REGIONDO_PURCHASE_HYDRATION_MAX_ATTEMPTS=5
REGIONDO_PURCHASE_HYDRATION_RETRY_BASE_DELAY_MS=500
REGIONDO_PURCHASE_HYDRATION_TIMEOUT_MS=15000
```

Use capped exponential delays, approximately `0`, `0.5`, `1.5`, `3.5`, and `7.5` seconds, while clamping each request timeout to the remaining hydration deadline.

Document the settings and behavior in `README.md`.

## 3. Represent uncertain outcomes explicitly

Add `RegiondoPurchaseRecoveryRequiredError` in `src/modules/regiondo/regiondo.client.ts`, extending `RegiondoApiError`.

Raise it when:

- the purchase POST times out or has an ambiguous network/`408`/`5xx` failure;
- Regiondo accepted the purchase but its snapshot did not hydrate before the deadline;
- a successful POST response is incomplete and provides no order identifier for recovery.

Include only safe reconciliation metadata:

- `reason`: `post_outcome_unknown` or `snapshot_unavailable`;
- `subId`;
- `orderNumber`;
- `orderId`;
- attempt count and upstream status when known.

Do not treat `sub_id` as an idempotency key and do not expose contact data, request bodies, signatures, or raw provider responses.

Handle this error before generic Regiondo errors in `src/http/errors.ts`. Return HTTP `502` with:

```json
{
  "ok": false,
  "code": "REGIONDO_PURCHASE_RECONCILIATION_REQUIRED",
  "retryable": false,
  "error": "The Regiondo purchase may already exist. Do not submit it again until the existing attempt is reconciled.",
  "reason": "snapshot_unavailable",
  "subId": "...",
  "orderNumber": "..."
}
```

Using `502` and `retryable: false` avoids suggesting that resubmitting the purchase is safe.

## 4. Add safe observability

Use `src/config/logger.ts` to emit structured events:

- `regiondo_request_retry_scheduled`;
- `regiondo_purchase_snapshot_poll_retry`;
- `regiondo_purchase_snapshot_hydrated`;
- `regiondo_purchase_reconciliation_required`.

Log method, path, attempts, delay, elapsed time, error class/status, `subId`, `orderId`, and `orderNumber`. Never log customer data, request bodies, signatures, or raw response bodies.

## 5. Test coverage

Extend `tests/unit/regiondo-client-checkout.test.ts`:

- A POST timeout/network failure produces exactly one POST and a recovery-required error.
- A POST `503` is not replayed.
- Receipt, two incomplete snapshots, then complete snapshot produces one POST and three GETs.
- Order-ID fallback tolerates empty supplier results, then hydrates successfully.
- Poll exhaustion respects attempts/deadline and retains useful validation details.
- Hydration GET `429`/`503` retries; authentication and permanent `4xx` responses stop immediately.
- Existing JSON compatibility and nested-envelope cases remain green.

Extend `tests/unit/http-errors.test.ts`:

- Recovery-required errors map to `502`, the stable code, and `retryable: false`.
- Known identifiers are returned.
- Raw provider data and customer data are not returned.

Extend `tests/unit/task-booking-links.test.ts`:

- Recovery-required failures roll back local task/booking links and propagate unchanged.

Verify with:

```text
npm test -- regiondo-client-checkout
npm test -- http-errors
npm test -- task-booking-links
npm run build
npm test
```

## 6. Deployment verification

- Confirm each booking attempt emits exactly one checkout POST.
- Confirm incomplete receipts cause only bounded GET polling.
- Confirm delayed successful hydrations and reconciliation-required outcomes are visible in structured logs.
- Confirm authentication failures are not retried.
- Monitor hydration latency, attempts per successful hydration, and reconciliation-required counts.
- Tell operators that a reconciliation-required response means they must search Regiondo using the order number or task `sub_id` before resubmitting.

## Deferred follow-up

Do not include a transaction/outbox redesign in this patch.

A later change should persist a `regiondo_purchase_attempts` record before the external call, block repeat submissions while an attempt is unresolved, and move Regiondo network calls outside the long database transaction. This requires a migration and state machine, and still cannot guarantee exactly-once creation without an idempotency mechanism supported by Regiondo.
