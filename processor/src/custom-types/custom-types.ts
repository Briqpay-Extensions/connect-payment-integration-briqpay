export const briqpayCustomTypeKey = 'briqpay-session-id'

export const briqpaySessionIdCustomType = {
  name: 'briqpay-session-id',
}

export interface BriqpayFieldDefinition {
  name: string
  label: string
  type: 'String'
  required: boolean
}

export const briqpayFieldDefinitions: BriqpayFieldDefinition[] = [
  // Session ID
  {
    name: process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id',
    label: 'Briqpay Session ID',
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
]
