export const briqpayCustomTypeKey = 'briqpaySessionId'

export const briqpaySessionIdCustomType = {
  name: 'briqpaySessionId',
}

export interface BriqpayFieldDefinition {
  name: string
  label: string
  type: 'String'
  required: boolean
}

export const briqpayFieldDefinitions: BriqpayFieldDefinition[] = [
  // Session ID
  { name: 'briqpaySessionId', label: 'Briqpay Session ID', type: 'String', required: false },

  // PSP Meta Data fields
  {
    name: 'briqpayPspMetaDataCustomerFacingReference',
    label: 'Briqpay PSP Customer Facing Reference',
    type: 'String',
    required: false,
  },
  { name: 'briqpayPspMetaDataDescription', label: 'Briqpay PSP Description', type: 'String', required: false },
  { name: 'briqpayPspMetaDataType', label: 'Briqpay PSP Type', type: 'String', required: false },
  { name: 'briqpayPspMetaDataPayerEmail', label: 'Briqpay PSP Payer Email', type: 'String', required: false },
  { name: 'briqpayPspMetaDataPayerFirstName', label: 'Briqpay PSP Payer First Name', type: 'String', required: false },
  { name: 'briqpayPspMetaDataPayerLastName', label: 'Briqpay PSP Payer Last Name', type: 'String', required: false },

  // Transaction Data fields
  {
    name: 'briqpayTransactionDataReservationId',
    label: 'Briqpay Transaction Reservation ID',
    type: 'String',
    required: false,
  },
  {
    name: 'briqpayTransactionDataSecondaryReservationId',
    label: 'Briqpay Transaction Secondary Reservation ID',
    type: 'String',
    required: false,
  },
  { name: 'briqpayTransactionDataPspId', label: 'Briqpay Transaction PSP ID', type: 'String', required: false },
  {
    name: 'briqpayTransactionDataPspDisplayName',
    label: 'Briqpay Transaction PSP Display Name',
    type: 'String',
    required: false,
  },
  {
    name: 'briqpayTransactionDataPspIntegrationName',
    label: 'Briqpay Transaction PSP Integration Name',
    type: 'String',
    required: false,
  },
]
