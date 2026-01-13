import { appLogger } from '../../payment-sdk'
import { apiRoot } from '../../libs/commercetools/api-root'
import {
  BriqpayFullSessionResponse,
  BriqpayPspMetadata,
  ExtractedBriqpayCustomFields,
} from '../types/briqpay-session-data.type'
import { MediumBriqpayResponse } from '../types/briqpay-payment.type'
import { briqpayCustomTypeKey } from '../../custom-types/custom-types'

/**
 * Service responsible for fetching full Briqpay session data and ingesting it
 * into CommerceTools order custom fields.
 *
 * Design principles:
 * - No fallback data: If a field is missing, it is simply not set
 * - Fail fast: API errors are propagated, not swallowed
 * - Idempotent: Safe to call multiple times for the same order
 */
export class BriqpaySessionDataService {
  private readonly baseUrl: string
  private readonly username: string
  private readonly secret: string

  constructor() {
    const baseUrl = process.env.BRIQPAY_BASE_URL
    const username = process.env.BRIQPAY_USERNAME
    const secret = process.env.BRIQPAY_SECRET

    if (!baseUrl || !username || !secret) {
      throw new Error(
        'Missing required Briqpay environment variables: BRIQPAY_BASE_URL, BRIQPAY_USERNAME, BRIQPAY_SECRET',
      )
    }

    this.baseUrl = baseUrl
    this.username = username
    this.secret = secret
  }

  /**
   * Fetches the full Briqpay session data from the API
   * This endpoint returns all session data including pspMetadata and transactions
   */
  public async fetchFullSession(sessionId: string): Promise<BriqpayFullSessionResponse> {
    const url = `${this.baseUrl}/session/${sessionId}`

    appLogger.info({ sessionId, url }, 'Fetching full Briqpay session data')

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      appLogger.error(
        {
          sessionId,
          status: response.status,
          statusText: response.statusText,
          errorText,
        },
        'Failed to fetch full Briqpay session',
      )
      throw new Error(`Failed to fetch Briqpay session ${sessionId}: ${response.status} ${response.statusText}`)
    }

    const sessionData: BriqpayFullSessionResponse = await response.json()

    appLogger.info(
      {
        sessionId,
        hasPspMetadata: !!sessionData.data?.pspMetadata,
        transactionCount: sessionData.data?.transactions?.length ?? 0,
        hasData: !!sessionData.data,
        dataKeys: sessionData.data ? Object.keys(sessionData.data) : [],
        rawSessionData: JSON.stringify(sessionData),
      },
      'Successfully fetched full Briqpay session data',
    )

    return sessionData
  }

  /**
   * Extracts custom field values from Briqpay session data
   * Only returns fields that have actual string values (not undefined/null/empty)
   *
   * For transactions, uses the first transaction in the array (primary transaction)
   */
  public extractCustomFields(
    sessionData: BriqpayFullSessionResponse | MediumBriqpayResponse,
  ): ExtractedBriqpayCustomFields {
    const result: ExtractedBriqpayCustomFields = {}

    // Extract PSP Metadata fields (only present in BriqpayFullSessionResponse)
    const pspMetadata: BriqpayPspMetadata | undefined = (sessionData as BriqpayFullSessionResponse).data?.pspMetadata
    if (pspMetadata) {
      this.setIfPresent(result, 'briqpayPspMetaDataCustomerFacingReference', pspMetadata.customerFacingReference)
      this.setIfPresent(result, 'briqpayPspMetaDataDescription', pspMetadata.description)
      this.setIfPresent(result, 'briqpayPspMetaDataType', pspMetadata.type)
      this.setIfPresent(result, 'briqpayPspMetaDataPayerEmail', pspMetadata.payerEmail)
      this.setIfPresent(result, 'briqpayPspMetaDataPayerFirstName', pspMetadata.payerFirstName)
      this.setIfPresent(result, 'briqpayPspMetaDataPayerLastName', pspMetadata.payerLastName)
    }

    // Extract Transaction Data fields from the first (primary) transaction
    const transactions = sessionData.data?.transactions
    appLogger.info(
      {
        hasTransactions: !!transactions,
        transactionCount: transactions?.length ?? 0,
        firstTransaction: transactions?.[0]
          ? {
              reservationId: transactions[0].reservationId,
              pspId: transactions[0].pspId,
              pspDisplayName: transactions[0].pspDisplayName,
              pspIntegrationName: transactions[0].pspIntegrationName,
            }
          : null,
      },
      'Extracting transaction data from Briqpay session',
    )

    if (transactions && transactions.length > 0) {
      const primaryTransaction = transactions[0]
      this.setIfPresent(result, 'briqpayTransactionDataReservationId', primaryTransaction.reservationId)
      // secondaryReservationId is only in some responses/payloads
      if ('secondaryReservationId' in primaryTransaction) {
        this.setIfPresent(
          result,
          'briqpayTransactionDataSecondaryReservationId',
          (primaryTransaction as any).secondaryReservationId,
        )
      }
      this.setIfPresent(result, 'briqpayTransactionDataPspId', primaryTransaction.pspId)
      this.setIfPresent(result, 'briqpayTransactionDataPspDisplayName', primaryTransaction.pspDisplayName)
      this.setIfPresent(result, 'briqpayTransactionDataPspIntegrationName', primaryTransaction.pspIntegrationName)
    }

    appLogger.info(
      {
        extractedFieldCount: Object.keys(result).length,
        extractedFields: Object.keys(result),
        extractedValues: result,
      },
      'Extracted custom fields from Briqpay session',
    )

    return result
  }

  /**
   * Updates an order's custom fields with extracted Briqpay session data
   *
   * @param orderId - The CommerceTools order ID
   * @param customFields - The extracted custom field values
   */
  public async updateOrderCustomFields(orderId: string, customFields: ExtractedBriqpayCustomFields): Promise<void> {
    const fieldEntries = Object.entries(customFields)

    if (fieldEntries.length === 0) {
      appLogger.info({ orderId }, 'No custom fields to update for order')
      return
    }

    appLogger.info(
      {
        orderId,
        fieldCount: fieldEntries.length,
        fields: Object.keys(customFields),
      },
      'Updating order custom fields with Briqpay session data',
    )

    // First, get the current order to obtain its version
    const orderResponse = await apiRoot.orders().withId({ ID: orderId }).get().execute()
    const order = orderResponse.body

    // Build the update actions for each custom field
    const actions = fieldEntries.map(([fieldName, value]) => ({
      action: 'setCustomField' as const,
      name: fieldName,
      value: value,
    }))

    // If order doesn't have custom type set, we need to set it first
    if (!order.custom) {
      appLogger.info({ orderId }, 'Setting custom type on order before updating fields')

      const setTypeResponse = await apiRoot
        .orders()
        .withId({ ID: orderId })
        .post({
          body: {
            version: order.version,
            actions: [
              {
                action: 'setCustomType',
                type: {
                  key: briqpayCustomTypeKey,
                  typeId: 'type',
                },
              },
            ],
          },
        })
        .execute()

      // Now update with the new version
      await apiRoot
        .orders()
        .withId({ ID: orderId })
        .post({
          body: {
            version: setTypeResponse.body.version,
            actions,
          },
        })
        .execute()
    } else {
      // Order already has custom type, just update the fields
      await apiRoot
        .orders()
        .withId({ ID: orderId })
        .post({
          body: {
            version: order.version,
            actions,
          },
        })
        .execute()
    }

    appLogger.info(
      {
        orderId,
        updatedFields: Object.keys(customFields),
      },
      'Successfully updated order custom fields with Briqpay session data',
    )
  }

  /**
   * Main entry point: Fetches Briqpay session data and updates the order's custom fields
   *
   * @param sessionId - The Briqpay session ID
   * @param orderId - The CommerceTools order ID
   */
  public async ingestSessionDataToOrder(sessionId: string, orderId: string): Promise<void> {
    appLogger.info({ sessionId, orderId }, 'Starting Briqpay session data ingestion to order')

    try {
      // 1. Fetch full session data from Briqpay
      const sessionData = await this.fetchFullSession(sessionId)

      // 2. Extract custom field values
      const customFields = this.extractCustomFields(sessionData)

      // 3. Update order custom fields
      await this.updateOrderCustomFields(orderId, customFields)

      appLogger.info({ sessionId, orderId }, 'Successfully completed Briqpay session data ingestion')
    } catch (error) {
      appLogger.error(
        {
          sessionId,
          orderId,
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to ingest Briqpay session data to order',
      )
      // Re-throw to let caller handle the error appropriately
      throw error
    }
  }

  /**
   * Helper to set a field only if the value is a non-empty string
   */
  private setIfPresent(
    target: ExtractedBriqpayCustomFields,
    key: keyof ExtractedBriqpayCustomFields,
    value: string | undefined | null,
  ): void {
    if (value !== undefined && value !== null && value !== '') {
      target[key] = value
    }
  }
}

// Lazy singleton getter to avoid initialization errors at module load time
let _instance: BriqpaySessionDataService | null = null
export function getBriqpaySessionDataService(): BriqpaySessionDataService {
  if (!_instance) {
    _instance = new BriqpaySessionDataService()
  }
  return _instance
}
