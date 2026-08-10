# Briqpay Payment Enabler

This module provides a frontend enabler application based on [commercetools Connect](https://docs.commercetools.com/connect) that integrates with [Briqpay](https://briqpay.com/) for payment UI components. It acts as a wrapper that loads the Briqpay payment widget and handles communication with the processor.

The enabler is designed to be loaded by the commercetools Checkout or directly integrated into a storefront. It renders the Briqpay payment iframe, handles session management, and processes payment decisions.

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Briqpay Events](#briqpay-events)
- [Testing](#testing)
- [Build Output](#build-output)

## Features

- **Briqpay Widget Integration**: Loads and renders the Briqpay payment iframe
- **Drop-in Component**: Embedded drop-in that handles the full payment flow
- **Session Management**: Communicates with the processor to create/update Briqpay sessions
- **Decision Handling**: Supports custom decision logic via events before payment completion
- **SDK Methods**: Provides suspend/resume/rehydrate functionality for cart updates

## Tech Stack

| Dependency        | Version |
| ----------------- | ------- |
| TypeScript        | 5.9.3   |
| Vite              | ^7.3.2  |
| Sass              | 1.94.2  |
| Jest              | 30.2.0  |
| @sinclair/typebox | 0.34.41 |

## Project Structure

```
enabler/
├── src/
│   ├── briqpay-sdk.ts                    # Briqpay SDK wrapper (suspend/resume/rehydrate)
│   ├── main.ts                           # Entry point - exports Enabler (alias for BriqpayPaymentEnabler)
│   ├── components/
│   │   ├── base.ts                       # Base component class
│   │   └── payment-methods/
│   │       └── briqpay/
│   │           └── briqpay.ts            # Briqpay payment component (registered for createComponentBuilder('briqpay'))
│   ├── dropin/
│   │   └── dropin-embedded.ts            # Embedded drop-in component
│   ├── dtos/
│   │   └── mock-payment.dto.ts           # Payment DTOs and schemas
│   ├── payment-enabler/
│   │   ├── payment-enabler.ts            # Interfaces and types
│   │   └── payment-enabler-briqpay.ts    # Briqpay enabler implementation
│   └── style/                            # SCSS styles
│       ├── _a11y.scss
│       ├── _colors.scss
│       ├── _variables.scss
│       ├── _vx.scss
│       ├── button.module.scss
│       ├── inputField.module.scss
│       └── style.module.scss
├── dev-utils/
│   └── session.js                        # Development utility for session creation
├── test/                                 # Test files
├── public/                               # Build output directory
├── index.html                            # Development test page
├── package.json
├── tsconfig.json
├── vite.config.ts
└── jest.config.ts
```

## Getting Started

Run all commands from the `enabler` folder.

### Install dependencies

```bash
npm install
```

### Run development server

Starts Vite dev server at http://localhost:3000 with hot module replacement:

```bash
npm run dev
```

### Build for production

Compiles TypeScript and builds the library to the `public` folder:

```bash
npm run build
```

### Preview production build

Serves the built files locally:

```bash
npm run preview
```

### Build and serve

Builds and serves the application on port 3000:

```bash
npm run serve
```

### Start production server

Serves the `public` folder on port 8080 (requires build first):

```bash
npm run start
```

### Linting

```bash
npm run lint
```

## Environment Variables

Copy `.env.template` to `.env` and configure the following variables:

| Variable                 | Description               | Example                                              |
| ------------------------ | ------------------------- | ---------------------------------------------------- |
| `VITE_CTP_AUTH_URL`      | commercetools Auth URL    | `https://auth.europe-west1.gcp.commercetools.com`    |
| `VITE_CTP_API_URL`       | commercetools API URL     | `https://api.europe-west1.gcp.commercetools.com`     |
| `VITE_CTP_SESSION_URL`   | commercetools Session URL | `https://session.europe-west1.gcp.commercetools.com` |
| `VITE_CTP_CLIENT_ID`     | API client ID             | -                                                    |
| `VITE_CTP_CLIENT_SECRET` | API client secret         | -                                                    |
| `VITE_CTP_PROJECT_KEY`   | Project key               | -                                                    |
| `VITE_PROCESSOR_URL`     | Processor URL             | `http://localhost:8080`                              |

> **Note**: These environment variables are only used for the development test page (`index.html`). In production, the enabler receives configuration from the commercetools Checkout or the integrating application.

## CT Session Creation (Merchant Backend Responsibility)

The enabler itself does not create commercetools Checkout sessions — the merchant backend does, and then hands the resulting `sessionId` to the enabler. When stamping `metadata.futureOrderNumber` on that CT Session, the merchant backend **must** check the cart's `briqpay-future-order-number` custom field first and reuse the value if it's already set. The processor writes that field on first Briqpay session creation specifically so it can be read back across CT Session rotations.

Skipping this read-back is the canonical source of the `Briqpay reference1` ≠ `Order.orderNumber` divergence (e.g. a customer enters checkout on Day 1, leaves, and completes the purchase on Day 3 — the merchant backend mints a fresh order number on Day 3 while the Briqpay session still carries the Day 1 number).

Reference implementation in `commerce-tools-frontend-demo/src/api/controllers/v1/checkout.ts`. See the top-level README's [Future Order Number Persistence](../README.md#future-order-number-persistence) section for the full rationale and code snippet.

### Optional: per-cart Briqpay variant

To render a specific Briqpay checkout variant for a cart (e.g. a currency- or market-specific one), set the `briqpay-variant-id` custom field on the cart **before** creating the CT Session / mounting the enabler. The processor reads it per session creation and forwards it as `product.variantId`; when unset, Briqpay uses the account default variant. This is chosen per cart by the merchant backend, not configured once for the whole connector. See the top-level README's [Per-Cart Variant Selection](../README.md#per-cart-variant-selection) section.

## Usage

### Basic Integration

```typescript
import { Enabler } from "connector-enabler";

// Create the enabler instance
const enabler = await Enabler.create({
  processorUrl: "https://your-processor-url",
  sessionId: "commercetools-session-id",
  onComplete: (result) => {
    if (result.isSuccess) {
      console.log("Payment completed:", result.paymentReference);
      // You must handle post-payment navigation here (e.g., redirect to your order confirmation page).
      // The connector does not perform automatic redirects after session completion.
      window.location.href = "/order-confirmation";
    }
  },
  onError: (error, context) => {
    console.error("Payment error:", error, context?.paymentReference);
  },
});

// Create and mount the drop-in
// "briqpay" matches the Payment Integration type set by the connector in commercetools Checkout.
// "embedded" is also accepted as a backward-compatible alias.
const builder = await enabler.createDropinBuilder("briqpay");
const dropin = builder.build({
  onDropinReady: async () => {
    console.log("Briqpay widget is ready");
  },
});

dropin.mount("#payment-container");
```

Required, and not part of `.build()` — see [Payment Decisions](#payment-decisions) below. The connector activates the decision step on every session, so Briqpay will ask for a decision, and the enabler always reads the handler registered via `registerBriqpayDecision`.

### EnablerOptions

| Option             | Type                                 | Required | Description                                                                                                                      |
| ------------------ | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `processorUrl`     | `string`                             | Yes      | URL of the payment processor                                                                                                     |
| `sessionId`        | `string`                             | Yes      | commercetools session ID                                                                                                         |
| `locale`           | `string`                             | No       | Locale for the payment widget                                                                                                    |
| `onComplete`       | `(result: PaymentResult) => void`    | No       | Callback when payment completes. You must handle post-payment navigation (e.g., redirect to confirmation page) in this callback. |
| `onError`          | `(error: unknown, context?) => void` | No       | Callback when an error occurs                                                                                                    |
| `onActionRequired` | `() => Promise<void>`                | No       | Callback when user action is required                                                                                            |

### PaymentResult

```typescript
type PaymentResult =
  | { isSuccess: true; paymentReference: string }
  | { isSuccess: false; paymentReference?: string };
```

## API Reference

### BriqpayPaymentEnabler

The main enabler class exported as `Enabler`.

#### Methods

| Method                                  | Returns                            | Description                                                                                     |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `create(options: EnablerOptions)`       | `Promise<BriqpayPaymentEnabler>`   | Static factory method to create an enabler instance                                             |
| `createDropinBuilder(type: DropinType)` | `Promise<PaymentDropinBuilder>`    | Creates a drop-in builder (supports `'briqpay'` and the backward-compatible `'embedded'` alias) |
| `createComponentBuilder(type: string)`  | `Promise<PaymentComponentBuilder>` | Creates a component builder (`'briqpay'`)                                                       |

### BriqpaySdk

The SDK instance is passed as the first argument to the handler registered via `registerBriqpayDecision`.

#### Methods

| Method                                      | Description                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `suspend()`                                 | Adds an overlay over the payment widget (use during cart updates, not for decisions)                         |
| `resume()`                                  | Removes the overlay and rehydrates the iframe                                                                |
| `rehydrate(autoRehydrate?: boolean)`        | Fetches latest session config and optionally resumes                                                         |

### DropinComponent

| Method                    | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `mount(selector: string)` | Mounts the drop-in to the specified DOM selector                 |
| `submit()`                | Submits the payment (called automatically on `session_complete`) |

### DropinOptions

| Option          | Type                   | Description                                |
| --------------- | ---------------------- | ------------------------------------------- |
| `onDropinReady` | `() => Promise<void>` | Optional. Called when the drop-in is ready  |

## Briqpay Events

The enabler subscribes to these Briqpay widget events on your behalf. You do not need to handle them yourself.

| Event              | Description                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `session_complete` | Fired when the payment session is completed. Triggers `submit()`.                                    |
| `make_decision`    | Fired when a decision is required. Routed to the handler registered via `registerBriqpayDecision`.   |

## Payment Decisions

The connector activates the decision step on every session it creates, so Briqpay will ask for a decision on some sessions regardless of whether a handler is registered. If nothing is registered, the enabler answers `ALLOW` automatically and the purchase proceeds as normal — register a handler only if you want to run your own validation first.

There is no `.build()`-time option for this: the enabler only ever *reads* `window.briqpayConnector.onDecision`, it never calls into your code to ask for it. Set it directly, at any time before the buyer reaches the payment step:

```typescript
window.briqpayConnector = window.briqpayConnector || {};
window.briqpayConnector.onDecision = async (sdk, data) => {
  const cartIsUnchanged = await checkCartAgainstSession(data.sessionId);

  if (cartIsUnchanged) {
    return { decision: "allow" };
  }

  // Reject without ending the session, so the buyer can correct and retry.
  return {
    decision: "reject",
    rejectionType: "notify_user",
    softErrors: [{ message: "Your cart changed, please review the total" }],
  };
};
```

`window.briqpayConnector` is this connector's own config namespace, kept deliberately separate from `window._briqpay` — Briqpay's core widget script's global (`briq.min.js`, shared across every Briqpay integration). Merchants only ever call into `_briqpay`; `briqpayConnector` is the reverse direction, a value the merchant sets and the enabler reads. The `|| {}` merge mirrors how commercetools' own SDK guards `window.commercetoolsCheckout` — nothing else populates `briqpayConnector` today, but it costs nothing and protects a future second key.

This works the same way whether you're rendering a custom UI (`createDropinBuilder`/`createComponentBuilder`) or embedding under the hosted commercetools Checkout (`paymentFlow`/`checkoutFlow`), which has no config surface of its own for this. It matters most for the hosted case: the enabler bundle is injected by commercetools' checkout application at a time you don't control, so a mechanism that requires calling *into* enabler code would race against that load — a plain assignment has no such dependency.

If you already import `connector-enabler` directly, `registerBriqpayDecision` is equivalent sugar for the same assignment, with type-checking on the callback:

```typescript
import { BRIQPAY_DECISION, BRIQPAY_REJECT_TYPE, registerBriqpayDecision } from "connector-enabler";

registerBriqpayDecision(async (sdk, data) => {
  const cartIsUnchanged = await checkCartAgainstSession(data.sessionId);

  if (cartIsUnchanged) {
    return { decision: BRIQPAY_DECISION.ALLOW };
  }

  return {
    decision: BRIQPAY_DECISION.REJECT,
    rejectionType: BRIQPAY_REJECT_TYPE.NOTIFY_USER,
    softErrors: [{ message: "Your cart changed, please review the total" }],
  };
});
```

`data` carries the `sessionId`, not the amounts, so compare against the session server-side.

> **Security note**: this handler runs in the buyer's browser, and the processor forwards its answer to Briqpay largely as given — it does not independently re-validate it. Treat this as an interim mechanism, not a trust boundary: perform any check the buyer must not be able to influence on your own server, not solely in this callback. A server-side decision path is planned and will replace this.

### DecisionAnswer

| Field           | Type                    | Description                                                                                                                       |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `decision`      | `BRIQPAY_DECISION`      | `ALLOW` or `REJECT`                                                                                                               |
| `rejectionType` | `BRIQPAY_REJECT_TYPE`   | `NOTIFY_USER` shows a message and keeps the session open; `REJECT_WITH_ERROR` closes it                                            |
| `softErrors`    | `{ message: string }[]` | Messages shown to the buyer with `NOTIFY_USER`                                                                                    |
| `hardError`     | `{ message: string }`   | Message shown in an overlay with `REJECT_WITH_ERROR`                                                                              |

Both enums and the `DecisionAnswer` type are exported from `connector-enabler`.

> **Note**: If the registered handler has not answered within 20 seconds, or throws, the decision is abandoned and nothing is sent. Briqpay blocks the purchase and asks the buyer to try again. Nothing is charged. This is different from having no handler registered at all — with nothing registered, the enabler answers `ALLOW` automatically so the purchase proceeds as if the decision step didn't exist. Only a handler that was actually asked to validate and failed to answer is treated as abandoned; a merchant who never opted in isn't blocked by a feature they didn't configure.

## Testing

Tests are written with Jest and use jsdom for DOM simulation.

```bash
# Run all tests
npm run test

# Run tests with coverage
npm run test:coverage
```

### Coverage Thresholds

| Metric     | Threshold |
| ---------- | --------- |
| Branches   | 75%       |
| Functions  | 75%       |
| Lines      | 75%       |
| Statements | 75%       |

## Build Output

The build produces two formats in the `public` folder:

| File                       | Format    | Description                                             |
| -------------------------- | --------- | ------------------------------------------------------- |
| `connector-enabler.es.js`  | ES Module | For modern bundlers and `<script type="module">`        |
| `connector-enabler.umd.js` | UMD       | For legacy environments and direct `<script>` inclusion |

### Library Configuration

The build is configured as a library with:

- **Entry**: `src/main.ts`
- **Name**: `Connector`
- **CSS**: Injected by JavaScript (no separate CSS file needed)

Styles are automatically injected into the document head with a `data-ctc-connector-styles` attribute for easy identification and cleanup.

## Development Test Page

The `index.html` file provides a development test page that:

1. Fetches a JWT token from a mock server (port 9002)
2. Creates a commercetools session for a cart
3. Initializes the enabler and mounts the Briqpay widget

To use the test page:

1. Start the processor on port 8080
2. Start a JWT mock server on port 9002 (via `docker compose up` from parent directory)
3. Configure `.env` with your commercetools credentials
4. Run `npm run dev`
5. Open http://localhost:3000
6. Enter a cart ID and click "Create checkout"
