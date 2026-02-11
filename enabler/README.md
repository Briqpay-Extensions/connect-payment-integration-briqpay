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
| Vite              | 7.2.4   |
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
│   │           └── briqpay.ts            # Briqpay payment component (currently unused)
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
      // Redirect to confirmation page
    }
  },
  onError: (error, context) => {
    console.error("Payment error:", error, context?.paymentReference);
  },
});

// Create and mount the drop-in
const builder = await enabler.createDropinBuilder("embedded");
const dropin = builder.build({
  onDropinReady: async () => {
    console.log("Briqpay widget is ready");
  },
  onBeforeDecision: async (sdk) => {
    // Optional: Perform validation before the decision flow proceeds
    // sdk.suspend() / sdk.resume() for cart updates
    // sdk.makeDecision(true) to allow payment
  },
});

dropin.mount("#payment-container");
```

### EnablerOptions

| Option             | Type                                 | Required | Description                           |
| ------------------ | ------------------------------------ | -------- | ------------------------------------- |
| `processorUrl`     | `string`                             | Yes      | URL of the payment processor          |
| `sessionId`        | `string`                             | Yes      | commercetools session ID              |
| `locale`           | `string`                             | No       | Locale for the payment widget         |
| `onComplete`       | `(result: PaymentResult) => void`    | No       | Callback when payment completes       |
| `onError`          | `(error: unknown, context?) => void` | No       | Callback when an error occurs         |
| `onActionRequired` | `() => Promise<void>`                | No       | Callback when user action is required |

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

| Method                                  | Returns                            | Description                                                      |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `create(options: EnablerOptions)`       | `Promise<BriqpayPaymentEnabler>`   | Static factory method to create an enabler instance              |
| `createDropinBuilder(type: DropinType)` | `Promise<PaymentDropinBuilder>`    | Creates a drop-in builder (supports `'embedded'`)                |
| `createComponentBuilder(type: string)`  | `Promise<PaymentComponentBuilder>` | Creates a component builder (currently no components registered) |

### BriqpaySdk

The SDK instance is available via the `onBeforeDecision` callback.

#### Methods

| Method                               | Description                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `suspend()`                          | Adds an overlay over the payment widget (use during cart updates)                |
| `resume()`                           | Removes the overlay and rehydrates the iframe                                    |
| `rehydrate(autoRehydrate?: boolean)` | Fetches latest session config and optionally resumes                             |
| `makeDecision(decision: boolean)`    | Makes a decision through the backend processor. `true` = allow, `false` = reject |

### DropinComponent

| Method                    | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `mount(selector: string)` | Mounts the drop-in to the specified DOM selector                 |
| `submit()`                | Submits the payment (called automatically on `session_complete`) |

### DropinOptions

| Option             | Type                                 | Description                                                                                                     |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `onDropinReady`    | `() => Promise<void>`                | Called when the drop-in is ready                                                                                |
| `onBeforeDecision` | `(sdk: BriqpaySdk) => Promise<void>` | Called before the decision flow when Briqpay's `make_decision` event fires. Use for validation or cart updates. |

## Briqpay Events

The enabler subscribes to Briqpay widget events and emits custom DOM events for integration.

### Subscribed Events

| Event              | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `session_complete` | Fired when the payment session is completed. Triggers `submit()`. |
| `make_decision`    | Fired when a decision is required before proceeding.              |

### Custom DOM Events

#### `briqpayDecision`

Dispatched when a decision is required. Listen to this event to implement custom validation logic.

```typescript
document.addEventListener("briqpayDecision", (event: CustomEvent) => {
  const data = event.detail.data;

  // Perform your validation...
  const isValid = validateOrder();

  // Respond with decision
  const responseEvent = new CustomEvent("briqpayDecisionResponse", {
    detail: {
      decision: isValid ? "allow" : "reject",
      // Optional rejection details:
      // rejectionType: 'notify_user',
      // softErrors: [{ message: 'Please fix...' }],
      // hardError: { message: 'Cannot proceed' }
    },
  });
  document.dispatchEvent(responseEvent);
});
```

#### Decision Response Options

| Field           | Type                                           | Description                            |
| --------------- | ---------------------------------------------- | -------------------------------------- |
| `decision`      | `'allow' \| 'reject'`                          | Whether to allow or reject the payment |
| `rejectionType` | `'reject_session_with_error' \| 'notify_user'` | How to handle rejection                |
| `softErrors`    | `{ message: string }[]`                        | Non-blocking error messages            |
| `hardError`     | `{ message: string }`                          | Blocking error message                 |

> **Note**: If no response is received within 10 seconds, the decision defaults to allow (`{ decision: true }`).

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
