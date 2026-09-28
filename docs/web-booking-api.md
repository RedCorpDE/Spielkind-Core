# WordPress web booking API

WordPress authenticates every Core request with `Authorization: Bearer <WORDPRESS_SERVICE_TOKEN>`.
The service token is server-side only and is limited by `WORDPRESS_SERVICE_SCOPES`. Customer access tokens are
forwarded separately in `X-Client-Authorization`; checkout status uses `X-Checkout-Token`.

Public catalog and checkout routes live under `/api/web`. Existing `/api/client` and `/api/admin` routes remain
unchanged. Core calculates pricing, availability, cancellation refunds, and all Stripe secret operations.

Required deployment order:

1. Configure the new WordPress environment variables from `.env.example`.
2. Run migration `525_web_booking_accounts_and_cancellation.sql`.
3. Deploy Core and verify the Stripe webhook worker is running.
4. Define `SPIELKIND_CORE_URL`, `SPIELKIND_CORE_SERVICE_TOKEN`, and `SPIELKIND_STRIPE_PUBLISHABLE_KEY` in `wp-config.php`.
5. Build and install `spielkind-booking.zip`, then add the **Spielkind Booking** and **Spielkind Account** blocks.

Checkout and management tokens are opaque random values. Core stores SHA-256 hashes only. They must never be
logged, localized into WordPress configuration, or reused as customer access tokens.
