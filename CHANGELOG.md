# Changelog

All notable changes to the Briqpay commercetools Connect plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [2.0.0] - 2026-08-21

### Added

- `/config` resolves the Briqpay session in one call using a cart payload hash, so the session is
  only updated when the cart has changed. New optional env `BRIQPAY_SYNCED_PAYLOAD_HASH_KEY`
  (default `briqpay-synced-payload-hash`) backed by a new cart custom field. Re-run the connector
  post-deploy to register the field. Without it the connector updates the session on every render,
  as before.
- Each CT Payment now records the PSP that processed it:
  `paymentMethodInfo.method` = Briqpay `pspIntegrationName` (e.g. `mollie_cards`),
  `paymentMethodInfo.name` = `pspDisplayName`.
- `/payments` stages the Briqpay session's custom-field data onto the cart, so orders are created
  with PSP data attached instead of waiting for the first webhook.
- Enabler: new `BriqpayProcessorError` export (`statusCode`, `code`, `request`). Use it to detect
  an expired commercetools session (401 `invalid_token`) and recover; the flow is documented in
  the enabler README. `/decision` and `/payments` failures now reach `onError` or reject instead
  of being swallowed.
- Amount mismatches between Briqpay and commercetools are logged at ERROR level across all payment
  flows.
- The plugin identifies itself to Briqpay with a `User-Agent` header carrying the plugin name and
  released version.

### Changed

- **Breaking:** `POST /payments` derives the authorization outcome from the Briqpay session. The
  request's `paymentOutcome` is ignored and `briqpaySessionId` was dropped from the schema. A
  client can no longer declare the outcome of its own payment. Previously a forged outcome could
  create a commercetools order without a completed Briqpay payment. It could never be captured, so
  no funds were at risk.
- **Breaking:** the Authorization transaction is written as `Pending` while the Briqpay session is
  still `order_pending` (async payment methods) and set to `Success` by the order-status webhook.
  Order creation waits for `Success`. Previously `/payments` always wrote `Success` immediately.
  Anything that reads `Authorization: Success` right after submit (thank-you pages, subscriptions,
  ERP triggers) must handle the `Pending` state. Synchronous payment methods still get `Success`
  immediately.
- **Breaking:** `paymentMethodInfo.method` is no longer the client-declared `paymentMethod.type`
  (see Added).
- **Breaking:** connector endpoints return real HTTP statuses and machine-readable codes instead
  of a generic 500: 400 `VALIDATION_ERROR`/`SESSION_ERROR`, 403 `SESSION_ERROR`,
  404 `SESSION_NOT_FOUND`, 409 `SESSION_ALREADY_COMPLETED`/`SESSION_INITIALIZATION_PENDING`,
  502 `UPSTREAM_ERROR`. Bodies follow the commercetools `ErrorResponse` shape.
- **Breaking:** `GET /config` returns a strict `{ snippet, briqpaySessionId }` object. The unused
  `clientKey` and `environment` fields are gone.
- `/decision` amount verification is now exact: the 5 minor unit tolerance was removed and
  `amountExVat` is compared along with `currency` and `amountIncVat`.
- **Breaking (enabler):** `DropinComponents.submit()` rejects with `BriqpayProcessorError` instead
  of calling `onError` internally. Mounting the dropin clears the target container before
  injecting the payment snippet.
- Webhook processing reads the HMAC-verified payload instead of re-fetching the full Briqpay
  session. Fewer upstream calls per webhook.
- commercetools SDK stack upgraded: `connect-payments-sdk` 1.2.1, `platform-sdk` 9.2.0,
  `ts-client` 5.0.0.

### Removed

- Enabler: the dead `createEnabler`/`createEnablerSync` exports and the unused second `context`
  parameter of `onError`.
- The unused `MOCK_CLIENT_KEY`/`MOCK_ENVIRONMENT` config keys.

### Fixed

- Remounting the dropin no longer duplicates the Briqpay script tag or event subscriptions, which
  produced duplicate `/payments` calls and `onComplete` firings.
- Session recovery only creates a replacement Briqpay session on a confirmed `SESSION_NOT_FOUND`,
  not on arbitrary errors. Completed or still-initializing sessions are returned untouched.
- `/operations/status` health-check name corrected from "Mock Payment API" to
  "Briqpay Payment API".

### Upgrade notes

- Re-run the connector post-deploy so the new `briqpay-synced-payload-hash` cart custom field is
  registered.
- Sessions in flight across the deploy may fail the exact amount check once. The buyer sees a soft
  reject and the session is repaired for the retry.
- Storefronts that read `Authorization: Success` immediately after submit must handle `Pending`
  appearing before `Success` for async payment methods.
- Update anything importing the removed enabler exports or declaring the removed `onError`
  parameter.
