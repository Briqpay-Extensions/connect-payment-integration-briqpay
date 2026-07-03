import { appLogger } from '../../payment-sdk'
import { apiRoot } from '../../libs/commercetools/api-root'
import {
  BriqpayFullSessionResponse,
  BriqpayPspMetadata,
  CtCustomFieldTarget,
  ExtractedBriqpayCustomFields,
} from '../types/briqpay-session-data.type'
import { MediumBriqpayResponse } from '../types/briqpay-payment.type'
import { getBriqpayTypeKey } from '../../connectors/actions'
import CtConflictRetry from '../../libs/commercetools/ct-conflict-retry'

// Briqpay only ever issues these two custom-field actions. Typed locally (rather than pulling
// the full OrderUpdateAction/CartUpdateAction unions) so the same actions array is assignable
// to both the orders() and carts() update builders.
type SetCustomTypeAction = {
  action: 'setCustomType'
  type: { key: string; typeId: 'type' }
}

type SetCustomFieldAction = {
  action: 'setCustomField'
  name: string
  value: string | boolean | undefined
}

type CtCustomFieldUpdateAction = SetCustomTypeAction | SetCustomFieldAction

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

    // No explicit timeout: webhook ingestion runs in the background (fire-and-forget), so a
    // slow Briqpay response delays nothing and still lands the data; undici's own transport
    // timeouts bound a truly hung connection.
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
    fieldMappings?: Record<string, string>,
  ): ExtractedBriqpayCustomFields {
    const result: ExtractedBriqpayCustomFields = {}

    // Helper to get field name from environment, fallback, or mapping
    const getFieldName = (envKey: string, fallback: string) => {
      const defaultName = process.env[envKey] || fallback
      return fieldMappings?.[defaultName] || defaultName
    }

    // Extract PSP Metadata fields (only present in BriqpayFullSessionResponse)
    const pspMetadata: BriqpayPspMetadata | undefined = (sessionData as BriqpayFullSessionResponse).data?.pspMetadata
    if (pspMetadata) {
      this.setIfPresent(
        result,
        getFieldName(
          'BRIQPAY_PSP_META_DATA_CUSTOMER_FACING_REFERENCE_KEY',
          'briqpay-psp-meta-data-customer-facing-reference',
        ),
        pspMetadata.customerFacingReference,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_PSP_META_DATA_DESCRIPTION_KEY', 'briqpay-psp-meta-data-description'),
        pspMetadata.description,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_PSP_META_DATA_TYPE_KEY', 'briqpay-psp-meta-data-type'),
        pspMetadata.type,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_PSP_META_DATA_PAYER_EMAIL_KEY', 'briqpay-psp-meta-data-payer-email'),
        pspMetadata.payerEmail,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_PSP_META_DATA_PAYER_FIRST_NAME_KEY', 'briqpay-psp-meta-data-payer-first-name'),
        pspMetadata.payerFirstName,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_PSP_META_DATA_PAYER_LAST_NAME_KEY', 'briqpay-psp-meta-data-payer-last-name'),
        pspMetadata.payerLastName,
      )
    }

    // Extract Transaction Data fields from the first (primary) transaction
    const transactions = sessionData.data?.transactions
    if (transactions && transactions.length > 0) {
      const primaryTransaction = transactions[0]
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_TRANSACTION_DATA_RESERVATION_ID_KEY', 'briqpay-transaction-data-reservation-id'),
        primaryTransaction.reservationId,
      )
      if ('secondaryReservationId' in primaryTransaction) {
        this.setIfPresent(
          result,
          getFieldName(
            'BRIQPAY_TRANSACTION_DATA_SECONDARY_RESERVATION_ID_KEY',
            'briqpay-transaction-data-secondary-reservation-id',
          ),
          (primaryTransaction as any).secondaryReservationId,
        )
      }
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_TRANSACTION_DATA_PSP_ID_KEY', 'briqpay-transaction-data-psp-id'),
        primaryTransaction.pspId,
      )
      this.setIfPresent(
        result,
        getFieldName('BRIQPAY_TRANSACTION_DATA_PSP_DISPLAY_NAME_KEY', 'briqpay-transaction-data-psp-display-name'),
        primaryTransaction.pspDisplayName,
      )
      this.setIfPresent(
        result,
        getFieldName(
          'BRIQPAY_TRANSACTION_DATA_PSP_INTEGRATION_NAME_KEY',
          'briqpay-transaction-data-psp-integration-name',
        ),
        primaryTransaction.pspIntegrationName,
      )
    }

    // Extract auto-captured flag from captures array
    const captures = sessionData.data?.captures
    if (captures && captures.length > 0) {
      const primaryCapture = captures[0]
      if (typeof primaryCapture.autoCaptured === 'boolean') {
        const fieldName = getFieldName('BRIQPAY_AUTOCAPTURED_KEY', 'briqpay-autocaptured')
        result[fieldName] = primaryCapture.autoCaptured
      }
    }

    return result
  }

  /**
   * Updates an order's custom fields with extracted Briqpay session data.
   * Thin delegate kept for the existing order ingestion path and its tests.
   *
   * @param orderId - The CommerceTools order ID
   * @param customFields - The extracted custom field values
   */
  public async updateOrderCustomFields(
    orderId: string,
    customFields: ExtractedBriqpayCustomFields,
    customTypeKey?: string,
  ): Promise<void> {
    return this.updateResourceCustomFields({ resource: 'order', id: orderId }, customFields, customTypeKey)
  }

  /**
   * Updates a CommerceTools order OR cart with extracted Briqpay session data.
   *
   * The GET-then-POST dance is wrapped in conflict-retry because the cart is far more
   * contended than a finalized order (concurrent /payments, addPayment, detach, session
   * writes). Each attempt re-fetches a fresh version AND re-evaluates the "needs custom
   * type" branch, so a concurrent writer that sets the type between attempts is observed.
   *
   * @param target - The order or cart to write to
   * @param customFields - The extracted custom field values
   * @param customTypeKey - Optional override for the custom type key
   */
  public async updateResourceCustomFields(
    target: CtCustomFieldTarget,
    customFields: ExtractedBriqpayCustomFields,
    customTypeKey?: string,
  ): Promise<void> {
    const fieldEntries = Object.entries(customFields)

    if (fieldEntries.length === 0) {
      appLogger.info({ resource: target.resource, resourceId: target.id }, 'No custom fields to update')
      return
    }

    appLogger.info(
      {
        resource: target.resource,
        resourceId: target.id,
        fieldCount: fieldEntries.length,
        fields: Object.keys(customFields),
        customTypeKey,
      },
      'Updating custom fields with Briqpay session data',
    )

    const fallbackTypeKey = await getBriqpayTypeKey()
    const actions: SetCustomFieldAction[] = fieldEntries.map(
      ([fieldName, value]): SetCustomFieldAction => ({
        action: 'setCustomField',
        name: fieldName,
        value,
      }),
    )

    let resolvedTypeKey: string = fallbackTypeKey

    const runUpdate = async (): Promise<void> => {
      // Re-fetch on every attempt for a fresh version AND a fresh custom-type decision.
      // IMPORTANT: expand custom.type to read the key, otherwise we only get id/typeId.
      const state = await this.fetchResourceCustomState(target)

      // Determine which custom type to use:
      // 1. Use provided customTypeKey if any
      // 2. Use the resource's current custom type if it exists (from expanded reference)
      // 3. Fallback to dynamically resolved Briqpay custom type
      resolvedTypeKey = customTypeKey || state.currentTypeKey || fallbackTypeKey

      // Only set the custom type if the resource doesn't have one yet. If it already has a
      // custom type, just update the fields to preserve existing values.
      if (!state.hasCustom) {
        appLogger.info(
          { resource: target.resource, resourceId: target.id, targetType: resolvedTypeKey },
          'Setting custom type (no existing custom type)',
        )

        const versionAfterType = await this.postResourceActions(target, state.version, [
          {
            action: 'setCustomType',
            type: {
              key: resolvedTypeKey,
              typeId: 'type',
            },
          },
        ])

        await this.postResourceActions(target, versionAfterType, actions)
      } else {
        // Ingestion re-runs on every webhook; writing identical values would bump the
        // resource version and spam order-changed messages, so only post actual changes.
        const changedActions = actions.filter((action) => state.fields?.[action.name] !== action.value)

        if (changedActions.length === 0) {
          appLogger.info(
            { resource: target.resource, resourceId: target.id, fields: Object.keys(customFields) },
            'Custom fields already up to date, skipping write',
          )

          return
        }

        await this.postResourceActions(target, state.version, changedActions)
      }
    }

    try {
      await CtConflictRetry.withConflictRetry(runUpdate)
    } catch (error) {
      // A pre-order webhook can race CT order auto-creation: by the time the cart write runs,
      // the cart may already be converted to an order. An Ordered cart is immutable (400
      // InvalidOperation); a deleted cart is 404. Either way it is a benign no-op for cart
      // staging - the order is enriched directly by a later webhook - not an ingestion failure.
      if (
        target.resource === 'cart' &&
        (CtConflictRetry.isNotFound(error) || CtConflictRetry.isInvalidOperation(error))
      ) {
        appLogger.info({ cartId: target.id }, 'Cart no longer writable (ordered or deleted), skipping cart staging')
        return
      }

      throw error
    }

    appLogger.info(
      {
        resource: target.resource,
        resourceId: target.id,
        updatedFields: Object.keys(customFields),
        targetTypeKey: resolvedTypeKey,
      },
      'Successfully updated custom fields with Briqpay session data',
    )
  }

  /**
   * Fetches the version, custom-type state, and current custom field values of an order or
   * cart. Expands custom.type so the current type key is available.
   */
  private async fetchResourceCustomState(target: CtCustomFieldTarget): Promise<{
    version: number
    hasCustom: boolean
    currentTypeKey: string | undefined
    fields: Record<string, unknown> | undefined
  }> {
    if (target.resource === 'order') {
      const response = await apiRoot
        .orders()
        .withId({ ID: target.id })
        .get({ queryArgs: { expand: ['custom.type'] } })
        .execute()
      const order = response.body

      return {
        version: order.version,
        hasCustom: !!order.custom,
        currentTypeKey: order.custom?.type.obj?.key,
        fields: order.custom?.fields,
      }
    }

    const response = await apiRoot
      .carts()
      .withId({ ID: target.id })
      .get({ queryArgs: { expand: ['custom.type'] } })
      .execute()
    const cart = response.body

    return {
      version: cart.version,
      hasCustom: !!cart.custom,
      currentTypeKey: cart.custom?.type.obj?.key,
      fields: cart.custom?.fields,
    }
  }

  /**
   * Posts custom-field update actions to an order or cart and returns the new version.
   */
  private async postResourceActions(
    target: CtCustomFieldTarget,
    version: number,
    actions: CtCustomFieldUpdateAction[],
  ): Promise<number> {
    if (target.resource === 'order') {
      const response = await apiRoot.orders().withId({ ID: target.id }).post({ body: { version, actions } }).execute()

      return response.body.version
    }

    const response = await apiRoot.carts().withId({ ID: target.id }).post({ body: { version, actions } }).execute()

    return response.body.version
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
      const target: CtCustomFieldTarget = { resource: 'order', id: orderId }
      const sessionData = await this.fetchFullSession(sessionId)
      const fieldContext = await this.buildFieldContextForResource(target)
      const customFields = this.extractCustomFields(sessionData, fieldContext?.mappings)
      const safeFields = this.dropFieldsNotInType(customFields, fieldContext?.validFieldNames, target)

      await this.updateResourceCustomFields(target, safeFields)

      appLogger.info({ sessionId, orderId }, 'Successfully completed Briqpay session data ingestion')
    } catch (error) {
      this.handleIngestionError(error, sessionId, { resource: 'order', id: orderId })
    }
  }

  /**
   * Stages Briqpay session data on the CART custom fields when the order does not exist yet.
   *
   * The cart always exists at webhook time, and CT copies the cart's custom fields onto the
   * order when it auto-creates the order from the tagged payment - so staging here makes the
   * order born with the data instead of losing it to the pre-order webhook race. Later
   * webhooks enrich the order directly once it exists.
   *
   * @param sessionId - The Briqpay session ID
   * @param cartId - The CommerceTools cart ID
   */
  public async ingestSessionDataToCart(sessionId: string, cartId: string): Promise<void> {
    appLogger.info({ sessionId, cartId }, 'Starting Briqpay session data ingestion to cart')

    try {
      const target: CtCustomFieldTarget = { resource: 'cart', id: cartId }
      const sessionData = await this.fetchFullSession(sessionId)
      const fieldContext = await this.buildFieldContextForResource(target)
      const customFields = this.extractCustomFields(sessionData, fieldContext?.mappings)
      const safeFields = this.dropFieldsNotInType(customFields, fieldContext?.validFieldNames, target)

      await this.updateResourceCustomFields(target, safeFields)

      appLogger.info({ sessionId, cartId }, 'Successfully completed Briqpay session data ingestion to cart')
    } catch (error) {
      this.handleIngestionError(error, sessionId, { resource: 'cart', id: cartId })
    }
  }

  /**
   * Resolves the field context for an order or cart from its custom type definition: the
   * name remapping for prefixed fields (conflict resolution) and the set of field names the
   * type actually defines. Cart and order share the same custom type, so this resolves
   * identically against whichever resource is targeted. Returns undefined when the resource
   * has no custom type yet - the caller then writes all fields under a freshly set Briqpay
   * type, which defines every field by construction.
   */
  private async buildFieldContextForResource(
    target: CtCustomFieldTarget,
  ): Promise<{ mappings: Record<string, string>; validFieldNames: Set<string> } | undefined> {
    const customTypeId = await this.fetchResourceCustomTypeId(target)

    if (!customTypeId) {
      return undefined
    }

    const typeResponse = await apiRoot.types().withId({ ID: customTypeId }).get().execute()
    const typeDefinition = typeResponse.body

    const mappings: Record<string, string> = {}
    const validFieldNames = new Set(typeDefinition.fieldDefinitions.map((f) => f.name))

    for (const fieldName of this.getPossibleBriqpayFieldNames()) {
      if (!validFieldNames.has(fieldName) && validFieldNames.has(`briqpay-${fieldName}`)) {
        mappings[fieldName] = `briqpay-${fieldName}`
      }
    }

    return { mappings, validFieldNames }
  }

  /**
   * Drops extracted fields the resource's custom type does not define. All fields are written
   * in one atomic setCustomField POST, so a single field the type is missing (e.g. a merchant
   * type predating a newly added field) makes commercetools reject the whole update with a
   * 400 - silently dropping every field. Filtering to defined fields lets the rest still land.
   * When validFieldNames is undefined (no existing custom type) nothing is dropped: the caller
   * sets the full Briqpay type, which defines every field.
   */
  private dropFieldsNotInType(
    fields: ExtractedBriqpayCustomFields,
    validFieldNames: Set<string> | undefined,
    target: CtCustomFieldTarget,
  ): ExtractedBriqpayCustomFields {
    if (!validFieldNames) {
      return fields
    }

    const kept: ExtractedBriqpayCustomFields = {}
    const dropped: string[] = []

    for (const [name, value] of Object.entries(fields)) {
      if (validFieldNames.has(name)) {
        kept[name] = value
      } else {
        dropped.push(name)
      }
    }

    if (dropped.length > 0) {
      appLogger.warn(
        { resource: target.resource, resourceId: target.id, dropped },
        'Dropping Briqpay fields not defined on the resource custom type - redeploy the connector to add them',
      )
    }

    return kept
  }

  /**
   * Returns the id of the custom type assigned to an order or cart, or undefined when none.
   */
  private async fetchResourceCustomTypeId(target: CtCustomFieldTarget): Promise<string | undefined> {
    if (target.resource === 'order') {
      const orderResponse = await apiRoot.orders().withId({ ID: target.id }).get().execute()

      return orderResponse.body.custom?.type.id
    }

    const cartResponse = await apiRoot.carts().withId({ ID: target.id }).get().execute()

    return cartResponse.body.custom?.type.id
  }

  /**
   * Gets all possible Briqpay field names based on environment configuration
   */
  private getPossibleBriqpayFieldNames(): string[] {
    return [
      'briqpay-session-id',
      process.env.BRIQPAY_PSP_META_DATA_CUSTOMER_FACING_REFERENCE_KEY ||
        'briqpay-psp-meta-data-customer-facing-reference',
      process.env.BRIQPAY_PSP_META_DATA_DESCRIPTION_KEY || 'briqpay-psp-meta-data-description',
      process.env.BRIQPAY_PSP_META_DATA_TYPE_KEY || 'briqpay-psp-meta-data-type',
      process.env.BRIQPAY_PSP_META_DATA_PAYER_EMAIL_KEY || 'briqpay-psp-meta-data-payer-email',
      process.env.BRIQPAY_PSP_META_DATA_PAYER_FIRST_NAME_KEY || 'briqpay-psp-meta-data-payer-first-name',
      process.env.BRIQPAY_PSP_META_DATA_PAYER_LAST_NAME_KEY || 'briqpay-psp-meta-data-payer-last-name',
      process.env.BRIQPAY_TRANSACTION_DATA_RESERVATION_ID_KEY || 'briqpay-transaction-data-reservation-id',
      process.env.BRIQPAY_TRANSACTION_DATA_SECONDARY_RESERVATION_ID_KEY ||
        'briqpay-transaction-data-secondary-reservation-id',
      process.env.BRIQPAY_TRANSACTION_DATA_PSP_ID_KEY || 'briqpay-transaction-data-psp-id',
      process.env.BRIQPAY_TRANSACTION_DATA_PSP_DISPLAY_NAME_KEY || 'briqpay-transaction-data-psp-display-name',
      process.env.BRIQPAY_TRANSACTION_DATA_PSP_INTEGRATION_NAME_KEY || 'briqpay-transaction-data-psp-integration-name',
      process.env.BRIQPAY_AUTOCAPTURED_KEY || 'briqpay-autocaptured',
    ]
  }

  /**
   * Handles ingestion errors with consistent logging.
   * Preserves the `orderId` log key for the order path (observability stability) and emits
   * `resource`/`resourceId` for the cart path.
   */
  private handleIngestionError(error: unknown, sessionId: string, target: CtCustomFieldTarget): never {
    const targetContext =
      target.resource === 'order' ? { orderId: target.id } : { resource: target.resource, resourceId: target.id }

    appLogger.error(
      {
        sessionId,
        ...targetContext,
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      },
      `Failed to ingest Briqpay session data to ${target.resource}`,
    )
    // Re-throw to let caller handle the error appropriately
    throw error
  }

  /**
   * Helper to set a field only if the value is a non-empty string
   */
  private setIfPresent(
    target: ExtractedBriqpayCustomFields,
    key: string,
    value: string | boolean | undefined | null,
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
