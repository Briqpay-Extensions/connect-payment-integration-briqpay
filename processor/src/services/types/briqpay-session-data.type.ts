/**
 * Types for Briqpay Session Data Ingestion
 *
 * These types represent the full Briqpay session response structure
 * used for extracting data into CommerceTools custom fields.
 */

/**
 * PSP Metadata from Briqpay session
 * All fields are optional as they may not be present in every session
 */
export interface BriqpayPspMetadata {
  customerFacingReference?: string
  description?: string
  type?: string
  payerEmail?: string
  payerFirstName?: string
  payerLastName?: string
}

/**
 * Transaction data from Briqpay session
 */
export interface BriqpayTransaction {
  createdAt?: string
  expiresAt?: string | null
  transactionId?: string
  reservationId?: string
  secondaryReservationId?: string
  pspId?: string
  pspDisplayName?: string
  pspIntegrationName?: string
  email?: string
  phoneNumber?: string
  amountIncVat?: number
  amountExVat?: number
  currency?: string
  status?: string
  sessionId?: string
  captureStatus?: string
  refundStatus?: string
}

/**
 * Full Briqpay session response structure for data ingestion
 */
export interface BriqpayFullSessionResponse {
  createdAt?: string
  sessionId: string
  status?: string
  data?: {
    pspMetadata?: BriqpayPspMetadata
    transactions?: BriqpayTransaction[]
    order?: {
      amountIncVat?: number
      amountExVat?: number
      currency?: string
    }
  }
}

/**
 * Extracted custom field data ready for CommerceTools order update
 * Only includes fields that have actual values (no undefined/null)
 */
export interface ExtractedBriqpayCustomFields {
  [key: string]: string | undefined
}

/**
 * Field mapping configuration for Briqpay session data to CT custom fields
 */
export const BRIQPAY_CUSTOM_FIELD_MAPPING = {
  // PSP Metadata fields
  pspMetaDataCustomerFacingReference: 'briqpayPspMetaDataCustomerFacingReference',
  pspMetaDataDescription: 'briqpayPspMetaDataDescription',
  pspMetaDataType: 'briqpayPspMetaDataType',
  pspMetaDataPayerEmail: 'briqpayPspMetaDataPayerEmail',
  pspMetaDataPayerFirstName: 'briqpayPspMetaDataPayerFirstName',
  pspMetaDataPayerLastName: 'briqpayPspMetaDataPayerLastName',
  // Transaction Data fields
  transactionDataReservationId: 'briqpayTransactionDataReservationId',
  transactionDataSecondaryReservationId: 'briqpayTransactionDataSecondaryReservationId',
  transactionDataPspId: 'briqpayTransactionDataPspId',
  transactionDataPspDisplayName: 'briqpayTransactionDataPspDisplayName',
  transactionDataPspIntegrationName: 'briqpayTransactionDataPspIntegrationName',
} as const
