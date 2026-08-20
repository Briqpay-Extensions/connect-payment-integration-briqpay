/**
 * Types for Briqpay session data ingestion into commercetools custom fields.
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
 * Extracted custom field data ready for CommerceTools order update
 * Only includes fields that have actual values (no undefined/null)
 */
export interface ExtractedBriqpayCustomFields {
  [key: string]: string | boolean | undefined
}

/**
 * Target resource for a Briqpay custom-field write.
 *
 * CT's `order` custom type is valid on both Orders and Carts (a Cart's CustomFields are
 * copied to the Order when the Cart is ordered), so the same extracted fields can be staged
 * on the cart before the order exists and written to the order once it does.
 */
export type CtCustomFieldTarget = { resource: 'order'; id: string } | { resource: 'cart'; id: string }

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
