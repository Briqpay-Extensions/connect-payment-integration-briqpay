# Changelog

All notable changes to the Briqpay commercetools Connect plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [2.0.2] - 2026-09-15

### Added

- Opt-in cart reconciliation, behind the new `BRIQPAY_RECONCILE_CART_ON_DRIFT` connector
  configuration key (set it to exactly `true`; anything else leaves carts untouched). When a cart has grown
  past what Briqpay authorized, the connector lowers it back to the lines the buyer actually paid
  for before creating the Payment, so Checkout converts a cart that matches the money. The paid
  lines come from the Briqpay session (a webhook payload carries the amounts but no lines), and
  they are matched back to line items by rebuilding the same bounded reference the session was
  sent with, so the match is exact even for hashed long references - never by price, so swapping
  one item for a different one at the same price is still recognised as the wrong item.

  Drift is judged on line composition, not on the total. A buyer who swaps a paid item for an
  equally priced one leaves the cart total untouched, and a totals-only comparison would wave that
  through.

  It refuses - leaving the cart untouched and the Payment planned at the authorized amount - on
  anything it cannot compute exactly: discount codes, direct discounts, discounted line items,
  custom line items, external tax modes, split shipping, tiered shipping rates, net-priced lines,
  two line items sharing one reference, a session line with no line-item equivalent, and a paid
  line that is no longer in the cart at all (re-adding it would need a price the session cannot
  vouch for). commercetools has no dry run for cart updates, so the resulting gross is computed
  first and the plan is only written when it equals the authorized amount to the cent; the cart is
  re-read and checked again afterwards.

### Fixed

- A CT Payment now plans the amount Briqpay actually authorized instead of the cart total at the
  moment the Payment is created. A cart stays mutable while the buyer is away at a redirect PSP,
  and commercetools Checkout builds the Order from the live cart - so a buyer who paid for one
  item and then added two more in a second tab got an Order for three items carrying a Payment
  whose `amountPlanned` matched the three-item cart while only the single item was authorized.
  The Order looked fully paid to every commercetools paid-in-full check, including the SDK's own
  `calculateTotalPaidAmount`. The Order still reflects the drifted cart - the connector must never
  write line items - but the Payment is now truthful, so the shortfall is visible in commercetools
  itself and fulfilment can be gated on it.
- The `Authorization` transaction written by `/payments` inherited the same cart-derived amount, so
  an authorization for less than the cart total was recorded at the cart total. It now carries the
  authorized amount too.

  Applies to all three paths that create a Payment: `/payments` (buyer returns), `/transactions`,
  and the order-status webhook fallback (buyer never returns). Amounts that agree are unaffected; a
  divergence is still logged as `Amount mismatch between Briqpay and commercetools` with the call
  site in `context`.

  This is detection, not prevention. Nothing in the connector can stop a storefront cart from being
  edited mid-payment; only the storefront can, by checking out against a cart the buyer cannot edit
  (`POST /carts/replicate` when checkout opens) or by rejecting cart writes while a payment is in
  flight (an API Extension, or `lockCart` with the `manage_locked_carts` scope).

## [2.0.1] - 2026-09-07

### Fixed

- Cart line references are now bounded in length. Some PSPs reject a line whose reference exceeds
  64 characters - Mollie returns `The 'sku' field should not be longer than 64 characters` and the
  payment fails to initialise. The connector previously passed merchant-authored values through
  unchanged and built discount references by joining commercetools discount ids, both of which
  could exceed the limit. Every reference is now capped at 63 UTF-8 bytes: a value that fits is
  sent unchanged, and a longer one keeps a recognisable head plus a hash of the full original, so
  it stays stable across session create, capture and refund.
- Two distinct cart lines can no longer resolve to the same reference. A per-item discount was
  named after the discounts applied to it, so two lines sharing one cart discount produced a
  single reference; lines with no SKU fell back to the localised product name, so two such lines
  with the same name also collided.
- A line's reference no longer depends on the cart locale, which previously meant the same line
  could be described differently in the session and in a later capture.

### Changed

- Cart line references are chosen from identifiers that are bounded by construction, matching how
  the commercetools Adyen connector references cart lines. Lines that already carry a SKU or a
  `key` are unaffected; the value sent is byte-identical to before.

  | Cart line                         | Reference                                        |
  | --------------------------------- | ------------------------------------------------ |
  | Product line item                 | `variant.sku`, else the line item id             |
  | Gift card or discounted line item | `key`, else the line item id                     |
  | Custom line item                  | `key`, else the custom line item id              |
  | Per-item discount                 | the discounted line's reference plus `-discount` |
  | Cart total discount               | `total-discount`                                 |
  | Shipping, shipping discount       | `shippingfee`, `shipping-discount`               |

- A custom line item is no longer referenced by its `slug`. commercetools requires `slug` on a
  custom line item but places no length or character rule on it, which made it the one field that
  could carry arbitrary text into a PSP.

### Security

- Updated `fast-uri` (3.1.7 / 4.1.4) and `fastify` (5.12.3) to clear four HIGH advisories against
  `fast-uri` (CVE-2026-75899, CVE-2026-75931, CVE-2026-75975, CVE-2026-76172) and a moderate
  `fastify` pair. Transitive dependencies only, no API change.

### Upgrade notes

- No configuration change and no commercetools change are required. Deploy the new version and the
  new references apply to sessions created from then on.
- References change for cart lines carrying a discount, for lines with no SKU, and for custom line
  items with no `key`. If you reconcile Briqpay order or capture lines back to commercetools by
  matching on the reference, review that mapping before deploying.
- To keep a readable, stable reference on a custom line item, set its `key` in commercetools. The
  `key` is preferred over the generated id, and only exceeds the cap past 63 bytes.
- A reference that falls back to a commercetools id is not stable between orders. commercetools
  generates a line item id and a custom line item id per cart, so a product with no SKU, or a fee
  with no `key`, is referenced differently in every order. Set a SKU or a `key` on anything you
  need to identify across orders.
- A reference longer than the cap is sent as the first 52 bytes of the original, a `-`, and 10 hex
  characters of its sha256. If a reference ends in a 10-character hex suffix and does not match
  anything in your catalogue, it is a capped value rather than the merchant's own identifier.
- A session created before the deploy and captured after it shows the previous reference on the
  order line and the new one on the capture line. The capture cart is traceability rather than a
  matching key, so nothing fails.
- Carts whose references change are detected as out of sync once and updated on the next render.
  This is the payload-hash check working as intended and needs no action.

## [2.0.0] - 2026-08-21

### Added

- `/config` resolves the Briqpay session in one call using a cart payload hash, so the session is
  only updated when the cart has changed. New optional env `BRIQPAY_SYNCED_PAYLOAD_HASH_KEY`
  (default `briqpay-synced-payload-hash`) backed by a new cart custom field. Re-run the connector
  post-deploy to register the field. Without it the connector updates the session on every render,
  as before.
- Each CT Payment now records the PSP that processed it:
  `paymentMethodInfo.method` = Briqpay `pspIntegrationName` (e.g. `Mollie - Card Payments`),
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
