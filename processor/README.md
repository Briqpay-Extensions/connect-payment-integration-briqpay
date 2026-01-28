# Briqpay Payment Integration Processor

This module provides a payment processor application based on [commercetools Connect](https://docs.commercetools.com/connect) that integrates with [Briqpay](https://briqpay.com/) for payment operations. It is triggered by HTTP requests from the Checkout UI (enabler) and handles payment session creation, capture, refund, cancel, and webhook notifications.

The processor fetches cart and payment details from commercetools Composable Commerce and communicates with the Briqpay API for payment operations.

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [Authentication](#authentication)
- [Connector Scripts](#connector-scripts)
- [Testing](#testing)
- [Docker](#docker)

## Features

- **Briqpay Session Management**: Create and update Briqpay payment sessions
- **Payment Operations**: Capture, refund, cancel, and reverse payments
- **Webhook Handling**: Process Briqpay notifications for order status, capture status, and refund status
- **Custom Types**: Automatic creation of commercetools custom types for storing Briqpay session data on orders (session ID, PSP metadata, transaction data)
- **Health Checks**: Status endpoint with health checks for both commercetools and Briqpay APIs

## Tech Stack

| Dependency                          | Version       |
| ----------------------------------- | ------------- |
| Node.js                             | ES2022 target |
| TypeScript                          | 5.9.3         |
| Fastify                             | 5.6.2         |
| @commercetools/connect-payments-sdk | 0.24.0        |
| @commercetools/platform-sdk         | ^8.14.0       |
| Jest                                | 30.2.0        |

## Project Structure

```
processor/
├── src/
│   ├── config/
│   │   ├── config.ts              # Application configuration
│   │   └── env-validation.ts      # Environment variable validation
│   ├── connectors/
│   │   ├── actions.ts             # Custom type creation for Briqpay
│   │   ├── post-deploy.ts         # Post-deployment script
│   │   └── pre-undeploy.ts        # Pre-undeployment script
│   ├── custom-types/              # Custom type definitions
│   ├── dtos/
│   │   ├── briqpay-payment.dto.ts # Briqpay-specific DTOs and schemas
│   │   └── operations/            # Operation DTOs (config, status, transactions, etc.)
│   ├── libs/
│   │   ├── briqpay/
│   │   │   └── BriqpayService.ts  # Briqpay API client
│   │   ├── commercetools/         # commercetools API utilities
│   │   ├── errors/                # Custom error classes
│   │   ├── fastify/               # Fastify plugins and middleware
│   │   └── logger/                # Application logger setup
│   ├── routes/
│   │   ├── briqpay-payment.route.ts  # Briqpay-specific routes
│   │   └── operation.route.ts        # Standard operation routes
│   ├── server/
│   │   ├── app.ts                 # Application services initialization
│   │   ├── server.ts              # Fastify server setup
│   │   └── plugins/               # Fastify plugins for routes
│   ├── services/
│   │   ├── abstract-payment.service.ts   # Base payment service
│   │   ├── briqpay-payment.service.ts    # Briqpay payment service implementation
│   │   ├── briqpay/
│   │   │   ├── notification.service.ts   # Webhook notification handling
│   │   │   ├── operation.service.ts      # Payment operations (capture, refund, etc.)
│   │   │   ├── session.service.ts        # Briqpay session management
│   │   │   ├── session-data.service.ts   # Session data management
│   │   │   └── utils.ts                  # Utility functions
│   │   └── types/                 # Service type definitions
│   ├── main.ts                    # Application entry point
│   └── payment-sdk.ts             # Payment SDK initialization
├── test/                          # Test files
├── package.json
├── tsconfig.json
└── jest.config.ts
```

## Getting Started

Run all commands from the `processor` folder.

### Install dependencies

```bash
npm install
```

### Build the application

Compiles TypeScript to JavaScript in the `dist` folder:

```bash
npm run build
```

### Run in development mode

Uses `ts-node` to run TypeScript directly:

```bash
npm run dev
```

### Run with file watching

Auto-restarts on file changes:

```bash
npm run watch
```

### Start the built application

Requires `npm run build` first:

```bash
npm run start
```

### Linting

```bash
# Check code style
npm run lint

# Fix code style issues
npm run lint:fix
```

## Environment Variables

Copy `.env.template` to `.env` and configure the following variables:

### commercetools Configuration

| Variable            | Description                 | Example                                                                   |
| ------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `CTP_AUTH_URL`      | commercetools Auth URL      | `https://auth.europe-west1.gcp.commercetools.com`                         |
| `CTP_API_URL`       | commercetools API URL       | `https://api.europe-west1.gcp.commercetools.com`                          |
| `CTP_SESSION_URL`   | commercetools Session URL   | `https://session.europe-west1.gcp.commercetools.com`                      |
| `CTP_CLIENT_ID`     | API client ID               | -                                                                         |
| `CTP_CLIENT_SECRET` | API client secret           | -                                                                         |
| `CTP_PROJECT_KEY`   | Project key                 | -                                                                         |
| `CTP_JWKS_URL`      | JWKS URL for JWT validation | `https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json` |
| `CTP_JWT_ISSUER`    | JWT issuer URL              | `https://mc-api.europe-west1.gcp.commercetools.com`                       |

### Briqpay Configuration

| Variable                                                | Description                                     | Example                                             |
| ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `BRIQPAY_USERNAME`                                      | Briqpay API username                            | -                                                   |
| `BRIQPAY_SECRET`                                        | Briqpay API secret                              | -                                                   |
| `BRIQPAY_BASE_URL`                                      | Briqpay API base URL                            | `https://playground-api.briqpay.com/v3`             |
| `BRIQPAY_TERMS_URL`                                     | URL to your terms and conditions                | `https://example.com/terms`                         |
| `BRIQPAY_CONFIRMATION_URL`                              | Order confirmation redirect URL                 | `https://yoursite.com/order-confirmation`           |
| `BRIQPAY_SESSION_CUSTOM_TYPE_KEY`                       | Custom type key for session storage             | `briqpay-session-id`                                |
| `BRIQPAY_PSP_META_DATA_CUSTOMER_FACING_REFERENCE_KEY`   | Key for PSP customer reference field            | `briqpay-psp-meta-data-customer-facing-reference`   |
| `BRIQPAY_PSP_META_DATA_DESCRIPTION_KEY`                 | Key for PSP description field                   | `briqpay-psp-meta-data-description`                 |
| `BRIQPAY_PSP_META_DATA_TYPE_KEY`                        | Key for PSP type field                          | `briqpay-psp-meta-data-type`                        |
| `BRIQPAY_PSP_META_DATA_PAYER_EMAIL_KEY`                 | Key for PSP payer email field                   | `briqpay-psp-meta-data-payer-email`                 |
| `BRIQPAY_PSP_META_DATA_PAYER_FIRST_NAME_KEY`            | Key for PSP payer first name field              | `briqpay-psp-meta-data-payer-first-name`            |
| `BRIQPAY_PSP_META_DATA_PAYER_LAST_NAME_KEY`             | Key for PSP payer last name field               | `briqpay-psp-meta-data-payer-last-name`             |
| `BRIQPAY_TRANSACTION_DATA_RESERVATION_ID_KEY`           | Key for transaction reservation ID field        | `briqpay-transaction-data-reservation-id`           |
| `BRIQPAY_TRANSACTION_DATA_SECONDARY_RESERVATION_ID_KEY` | Key for transaction secondary reservation field | `briqpay-transaction-data-secondary-reservation-id` |
| `BRIQPAY_TRANSACTION_DATA_PSP_ID_KEY`                   | Key for transaction PSP ID field                | `briqpay-transaction-data-psp-id`                   |
| `BRIQPAY_TRANSACTION_DATA_PSP_DISPLAY_NAME_KEY`         | Key for transaction PSP display name field      | `briqpay-transaction-data-psp-display-name`         |
| `BRIQPAY_TRANSACTION_DATA_PSP_INTEGRATION_NAME_KEY`     | Key for transaction PSP integration name field  | `briqpay-transaction-data-psp-integration-name`     |
| `BRIQPAY_WEBHOOK_SECRET`                                | Briqpay webhook signing secret (Mandatory)      | -                                                   |
| `ALLOWED_ORIGINS`                                       | Comma-separated list of allowed CORS origins    | -                                                   |

### Application Configuration

| Variable               | Description                          | Default                              |
| ---------------------- | ------------------------------------ | ------------------------------------ |
| `PORT`                 | Server port                          | `8080`                               |
| `LOGGER_LEVEL`         | Log level (debug, info, warn, error) | `info`                               |
| `HEALTH_CHECK_TIMEOUT` | Health check timeout in ms           | `5000`                               |
| `MERCHANT_RETURN_URL`  | Fallback return URL                  | -                                    |
| `PREVIEW_HOSTNAME`     | Override hostname for webhook URLs   | -                                    |
| `URL`                  | Processor URL for webhooks           | `https://[PLUGIN_URL]/notifications` |

### Required commercetools Permissions

The API client must have the following scopes:

> Please refer to the [commercetools documentation regarding scopes](https://docs.commercetools.com/api/scopes), names may change and names might be different from what you see in the GUI.

- **Manage**:
  - `manage_orders:briqpay-plugin`
  - `manage_sessions:briqpay-plugin`
  - `manage_types:briqpay-plugin`
  - `manage_payments:briqpay-plugin`
  - `manage_checkout_transactions:briqpay-plugin`
  - `manage_checkout_payment_intents:briqpay-plugin`
  - `manage_key_value_documents:briqpay-plugin`
- **View**:
  - `view_key_value_documents:briqpay-plugin` (View Custom Objects)
  - `view_states:briqpay-plugin`
  - `view_product_selections:briqpay-plugin`
  - `view_attribute_groups:briqpay-plugin`
  - `view_shopping_lists:briqpay-plugin`
  - `view_shipping_methods:briqpay-plugin`
  - `view_categories:briqpay-plugin`
  - `view_discount_codes:briqpay-plugin`
  - `view_products:briqpay-plugin`
  - `view_cart_discounts:briqpay-plugin`
  - `view_stores:briqpay-plugin`
  - `view_tax_categories:briqpay-plugin`
  - `view_order_edits:briqpay-plugin`

## API Endpoints

### Briqpay Payment Routes (root level)

| Method | Path             | Auth    | Description                                         |
| ------ | ---------------- | ------- | --------------------------------------------------- |
| `GET`  | `/config`        | Session | Get Briqpay session config and HTML snippet         |
| `POST` | `/payments`      | Session | Create a payment                                    |
| `POST` | `/decision`      | Session | Make a decision on a Briqpay session (allow/reject) |
| `POST` | `/notifications` | None    | Receive Briqpay webhook notifications               |

### Operation Routes (`/operations` prefix)

| Method | Path                              | Auth    | Description                                    |
| ------ | --------------------------------- | ------- | ---------------------------------------------- |
| `GET`  | `/operations/config`              | Session | Get payment configuration                      |
| `GET`  | `/operations/status`              | JWT     | Get system health status                       |
| `GET`  | `/operations/payment-components`  | JWT     | Get supported payment components               |
| `POST` | `/operations/payment-intents/:id` | OAuth2  | Modify payment (capture/cancel/refund/reverse) |
| `POST` | `/operations/transactions`        | OAuth2  | Create a transaction                           |

### Payment Intent Actions

The `/operations/payment-intents/:id` endpoint supports the following actions:

- `capturePayment` - Capture an authorized payment
- `cancelPayment` - Cancel an authorized payment
- `refundPayment` - Refund a captured payment
- `reversePayment` - Reverse a payment (automated reversals)

## Authentication

The processor uses three authentication mechanisms:

### Session Authentication

Used for frontend-facing endpoints. Requires `x-session-id` header with a valid commercetools session ID.

```bash
curl -H "x-session-id: <session-id>" https://processor-url/config
```

### OAuth2 Authentication

Used for backend operations. Requires a Bearer token from commercetools OAuth2 server.

```bash
curl -H "Authorization: Bearer <oauth-token>" \
  https://processor-url/operations/payment-intents/<id>
```

### JWT Authentication

Used for Merchant Center integrations. Requires a JWT token from the Merchant Center forward-to proxy.

For local development, use the included JWT mock server:

```bash
# Set environment variable
export CTP_JWKS_URL="http://localhost:9002/jwt/.well-known/jwks.json"

# Start JWT mock server
docker compose up -d

# Obtain a test token
curl -X POST 'http://localhost:9002/jwt/token' \
  -H 'Content-Type: application/json' \
  -d '{
    "iss": "https://mc-api.europe-west1.gcp.commercetools.com",
    "sub": "subject",
    "https://mc-api.europe-west1.gcp.commercetools.com/claims/project_key": "<project-key>"
  }'
```

## Connector Scripts

### Post-Deploy Script

Creates the Briqpay custom type in commercetools for storing session IDs on orders.

```bash
# Build first
npm run build

# Run post-deploy
npm run connector:post-deploy
```

The script creates a custom type with key `briqpay-session-id` (configurable via `BRIQPAY_SESSION_CUSTOM_TYPE_KEY`) on the `order` resource type. All field keys are also configurable via environment variables (see [Environment Variables](#environment-variables)). The default fields are:

- `briqpay-session-id` - Session ID
- `briqpay-psp-meta-data-customer-facing-reference` - PSP customer reference
- `briqpay-psp-meta-data-description` - PSP description
- `briqpay-psp-meta-data-type` - PSP type
- `briqpay-psp-meta-data-payer-email` - Payer email
- `briqpay-psp-meta-data-payer-first-name` - Payer first name
- `briqpay-psp-meta-data-payer-last-name` - Payer last name
- `briqpay-transaction-data-reservation-id` - Reservation ID
- `briqpay-transaction-data-secondary-reservation-id` - Secondary reservation ID
- `briqpay-transaction-data-psp-id` - PSP ID
- `briqpay-transaction-data-psp-display-name` - PSP display name
- `briqpay-transaction-data-psp-integration-name` - PSP integration name

### Pre-Undeploy Script

Currently performs no actions but is available for cleanup operations if needed.

```bash
npm run connector:pre-undeploy
```

## Testing

Tests are written with Jest and located in the `test/` directory.

```bash
# Run all tests
npm run test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Coverage Thresholds

The project enforces minimum coverage thresholds:

| Metric     | Threshold |
| ---------- | --------- |
| Branches   | 75%       |
| Functions  | 75%       |
| Lines      | 75%       |
| Statements | 75%       |

## Docker

A `docker-compose.yaml` is provided for running a JWT mock server during local development:

```yaml
services:
  jwt-server:
    image: node:24.11.1-alpine
    command: npx --package jwt-mock-server -y start
    ports:
      - 9002:9000
```

```bash
# Start the JWT mock server
docker compose up -d

# Stop the server
docker compose down
```

## Webhook Events

The processor handles the following Briqpay webhook events:

### Order Status Events

- `order_pending` - Order is pending approval
- `order_rejected` - Order was rejected
- `order_cancelled` - Order was cancelled
- `order_approved_not_captured` - Order approved but not yet captured

### Capture Status Events

- `pending` - Capture is pending
- `approved` - Capture was approved
- `rejected` - Capture was rejected

### Refund Status Events

- `pending` - Refund is pending
- `approved` - Refund was approved
- `rejected` - Refund was rejected

## Supported Payment Components

The processor reports support for:

```json
{
  "dropins": [{ "type": "embedded" }],
  "components": []
}
```

## Security

The processor implements several security measures for production readiness:

### Authentication & Authorization

- **Session Authentication**: Frontend requests require valid commercetools session ID (`X-Session-ID` header)
- **OAuth2 Authentication**: Backend operations require Bearer tokens from commercetools
- **JWT Validation**: Merchant Center integrations validated via commercetools JWKS endpoint

### Input Validation

- **TypeBox Schema Validation**: All request bodies validated against strict schemas
- **Session ID Pattern**: Regex validation (`^[a-zA-Z0-9-_]{1,128}$`) prevents injection attacks
- **Array Size Limits**: Prevents DoS via oversized payloads

### Webhook Security

- **HMAC Verification**: Webhooks are verified using mandatory HMAC-SHA256 signatures. `BRIQPAY_WEBHOOK_SECRET` must be configured for the processor to function.
- **Duplicate Detection**: Checks if authorization already exists before processing
- **Audit Logging**: All webhook processing logged with correlation IDs

### Security Headers

All responses include security headers:

- `X-Frame-Options: DENY` - Prevents clickjacking
- `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
- `X-XSS-Protection: 1; mode=block` - XSS filter
- `Strict-Transport-Security` - HTTPS enforcement
- `Content-Security-Policy` - CSP protection
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` - Restricts browser features (geolocation, microphone, camera)

### CORS Configuration

Configure allowed origins in production:

```bash
ALLOWED_ORIGINS=https://your-frontend.com,https://admin.your-site.com
```

### Environment Validation

The processor validates all required environment variables at startup and fails fast if configuration is missing or invalid. Sensitive URLs must use HTTPS.

### Audit Logging

All requests are logged with:

- Request method, URL, IP address
- User-Agent and Origin headers
- Session ID presence (masked)
- Response status code and timing
- Correlation IDs for tracing
