export const briqpayCustomTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'

// The field name for storing the Briqpay session ID on carts/orders.
// This is intentionally NOT derived from BRIQPAY_SESSION_CUSTOM_TYPE_KEY,
// which controls the custom type key (not the field name).
export const briqpaySessionIdFieldName = 'briqpay-session-id'

// Field name for the order number the merchant intends for this cart. The connector
// persists this on the cart at Briqpay-session creation so the merchant backend can
// read it back on subsequent checkout entries and reuse it when stamping CT Session
// metadata.futureOrderNumber — preventing the Briqpay reference1 ≠ Order.orderNumber
// divergence that occurs when the merchant regenerates the number on every entry.
// Overridable via BRIQPAY_FUTURE_ORDER_NUMBER_KEY for merchants who already use a
// differently-named custom field for the same concept on their carts.
export const briqpayFutureOrderNumberFieldName =
  process.env.BRIQPAY_FUTURE_ORDER_NUMBER_KEY || 'briqpay-future-order-number'

// Field name for the Checkout transaction-item id that links a CT Payment to the cart so
// commercetools Checkout auto-creates the Order. Persisted on the cart at config() time - the
// only point the connector holds the CT Checkout session - so the HMAC webhook, which has no
// session, can read it back and create a correctly-tagged Payment when the buyer never returns to
// trigger /payments (e.g. closed the tab on an HPP redirect). Overridable for merchants who
// already use a differently-named field.
export const briqpayCheckoutTransactionItemIdFieldName =
  process.env.BRIQPAY_CHECKOUT_TRANSACTION_ITEM_ID_KEY || 'briqpay-checkout-transaction-item-id'

export const briqpaySessionIdCustomType = {
  name: briqpaySessionIdFieldName,
}

export interface BriqpayFieldDefinition {
  name: string
  label: string
  type: 'String' | 'Boolean'
  required: boolean
}

// IMPORTANT: Please use the default names to preserve data integrity.
export const briqpayFieldDefinitions: BriqpayFieldDefinition[] = [
  // Session ID
  {
    name: briqpaySessionIdFieldName,
    label: 'Briqpay Session ID',
    type: 'String',
    required: false,
  },

  // Future order number — persisted by the connector at first session creation.
  // Merchant backend should read this back on subsequent checkout entries instead
  // of regenerating, to keep Briqpay reference1 in sync with Order.orderNumber.
  {
    name: briqpayFutureOrderNumberFieldName,
    label: 'Briqpay Future Order Number',
    type: 'String',
    required: false,
  },

  // Checkout transaction-item id — persisted at config() so the session-less webhook can create
  // a correctly-tagged Payment for the buyer-never-returns (HPP tab-close) case.
  {
    name: briqpayCheckoutTransactionItemIdFieldName,
    label: 'Briqpay Checkout Transaction Item ID',
    type: 'String',
    required: false,
  },

  // PSP Meta Data fields
  {
    name:
      process.env.BRIQPAY_PSP_META_DATA_CUSTOMER_FACING_REFERENCE_KEY ||
      'briqpay-psp-meta-data-customer-facing-reference',
    label: 'Briqpay PSP Customer Facing Reference',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_DESCRIPTION_KEY || 'briqpay-psp-meta-data-description',
    label: 'Briqpay PSP Description',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_TYPE_KEY || 'briqpay-psp-meta-data-type',
    label: 'Briqpay PSP Type',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_EMAIL_KEY || 'briqpay-psp-meta-data-payer-email',
    label: 'Briqpay PSP Payer Email',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_FIRST_NAME_KEY || 'briqpay-psp-meta-data-payer-first-name',
    label: 'Briqpay PSP Payer First Name',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_LAST_NAME_KEY || 'briqpay-psp-meta-data-payer-last-name',
    label: 'Briqpay PSP Payer Last Name',
    type: 'String',
    required: false,
  },

  // Transaction Data fields
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_RESERVATION_ID_KEY || 'briqpay-transaction-data-reservation-id',
    label: 'Briqpay Transaction Reservation ID',
    type: 'String',
    required: false,
  },
  {
    name:
      process.env.BRIQPAY_TRANSACTION_DATA_SECONDARY_RESERVATION_ID_KEY ||
      'briqpay-transaction-data-secondary-reservation-id',
    label: 'Briqpay Transaction Secondary Reservation ID',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_PSP_ID_KEY || 'briqpay-transaction-data-psp-id',
    label: 'Briqpay Transaction PSP ID',
    type: 'String',
    required: false,
  },
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_PSP_DISPLAY_NAME_KEY || 'briqpay-transaction-data-psp-display-name',
    label: 'Briqpay Transaction PSP Display Name',
    type: 'String',
    required: false,
  },
  {
    name:
      process.env.BRIQPAY_TRANSACTION_DATA_PSP_INTEGRATION_NAME_KEY || 'briqpay-transaction-data-psp-integration-name',
    label: 'Briqpay Transaction PSP Integration Name',
    type: 'String',
    required: false,
  },

  // Auto-capture flag
  {
    name: process.env.BRIQPAY_AUTOCAPTURED_KEY || 'briqpay-autocaptured',
    label: 'Briqpay Auto-Captured',
    type: 'Boolean',
    required: false,
  },
]
