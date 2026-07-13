import { Cart, CommercetoolsCartService } from '@commercetools/connect-payments-sdk'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import type { Cart as PlatformCart } from '@commercetools/platform-sdk'
import { CustomLineItem, LineItem } from '@commercetools/platform-sdk'
import { appLogger } from '../../payment-sdk'
import { CartItem, ITEM_PRODUCT_TYPE, MediumBriqpayResponse } from '../types/briqpay-payment.type'
import Briqpay, { mapCustomLineItem } from '../../libs/briqpay/BriqpayService'
import { apiRoot } from '../../libs/commercetools/api-root'
import { SessionError } from '../../libs/errors/briqpay-errors'
import CtConflictRetry from '../../libs/commercetools/ct-conflict-retry'
import { getBriqpayTypeKey } from '../../connectors/actions'
import {
  briqpayCheckoutTransactionItemIdFieldName,
  briqpayFutureOrderNumberFieldName,
  briqpaySessionIdFieldName,
} from '../../custom-types/custom-types'

type SetCustomFieldAction = { action: 'setCustomField'; name: string; value: string }

export class BriqpaySessionService {
  constructor(private readonly ctCartService: CommercetoolsCartService) {}

  /**
   * Persists Briqpay session metadata on the cart custom fields.
   *
   * Writes:
   *  - `briqpay-session-id`: always kept in sync with the active Briqpay session.
   *  - `briqpay-future-order-number`: write-once at first session creation. The
   *    merchant backend is expected to read this back on subsequent checkout
   *    entries and reuse it when stamping CT Session metadata, so Briqpay's
   *    `reference1` stays in sync with the eventual `Order.orderNumber`.
   *
   * Never overwrites an existing `briqpay-future-order-number` — the value
   * captured on first checkout entry is the canonical one.
   *
   * The cart is heavily contended while Checkout loads: CT Checkout and the storefront
   * update it concurrently with /config, and the caller's snapshot predates the slow
   * Briqpay session calls, so its version is routinely stale by write time (observed as
   * 409 ConcurrentModification -> 500 -> the payment widget never renders). The whole
   * read-derive-write sequence is therefore wrapped in conflict-retry: each attempt
   * re-fetches the cart for a fresh version AND re-derives the actions, so a concurrent
   * writer that already persisted the same metadata turns the retry into a clean no-op.
   *
   * @param ctCart - The cart to attach Briqpay session metadata to
   * @param briqpaySessionId - Briqpay session id
   * @param futureOrderNumber - Order number the merchant intends for this cart (optional)
   */
  public async updateCartWithBriqpaySession(
    ctCart: Cart,
    briqpaySessionId: string,
    futureOrderNumber?: string,
    checkoutTransactionItemId?: string,
  ): Promise<void> {
    // The session id on the caller's snapshot: absent on first entry, the buyer's active
    // session on re-entry, or the id being knowingly replaced on session re-creation.
    const snapshotSessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName]

    // These fields are only ever written by this flow with session-derived values, so a
    // snapshot that already matches proves the write is a no-op (the common case on widget
    // reload) - skip the fetch-and-write round trips entirely.
    const alreadyInSync =
      ctCart.custom !== undefined &&
      this.buildSessionMetadataActions(ctCart, briqpaySessionId, futureOrderNumber, checkoutTransactionItemId)
        .length === 0

    if (alreadyInSync) {
      return
    }

    const runUpdate = async (): Promise<void> => {
      const cart = await this.ctCartService.getCart({ id: ctCart.id })

      const versionForUpdate = cart.custom
        ? cart.version
        : await this.setBriqpayCustomTypeOnCart(cart, briqpaySessionId)

      const actions = this.buildSessionMetadataActions(
        cart,
        briqpaySessionId,
        futureOrderNumber,
        checkoutTransactionItemId,
      )

      if (actions.length === 0) {
        return
      }

      appLogger.info(
        {
          briqpaySessionId,
          persistedFutureOrderNumber: actions.some((a) => a.name === briqpayFutureOrderNumberFieldName)
            ? futureOrderNumber
            : undefined,
          actionNames: actions.map((a) => a.name),
        },
        'Updating cart custom fields with Briqpay session metadata',
      )

      await apiRoot
        .carts()
        .withId({ ID: cart.id })
        .post({
          body: {
            version: versionForUpdate,
            actions,
          },
        })
        .execute()
    }

    try {
      await CtConflictRetry.withConflictRetry(runUpdate)
    } catch (error) {
      // The buyer can complete payment while /config is in flight: CT then converts the
      // cart to an Order (immutable -> 400 InvalidOperation). The metadata write is
      // pointless then and must not block rendering the widget for the already-paid
      // session - the Order is enriched via webhook ingestion.
      // CT also answers 400 InvalidOperation for permanent misconfigurations (type key
      // missing from the project, field not defined on the cart's type), so the error code
      // alone is NOT proof the cart is unwritable - only swallow when the probe proves the
      // cart was Ordered. Everything else stays loud: misconfigurations, Frozen/Merged
      // carts (a silently dropped write there would block Order linking after unfreeze),
      // and 404s (a deleted cart has no payment yet and can never link to an order, so
      // rendering a payable widget for it would orphan the payment).
      // The swallow also requires the write to be for the buyer's OWN session (first entry
      // or the id already on the cart). A different id on an ordered cart is a replacement
      // session created after checkout completed - rendering its payable widget could
      // double-charge the buyer, so that stays loud too.
      const wroteBuyersOwnSession = !snapshotSessionId || snapshotSessionId === briqpaySessionId
      const cartOrderedDuringUpdate =
        wroteBuyersOwnSession && CtConflictRetry.isInvalidOperation(error) && (await this.hasCartBeenOrdered(ctCart.id))

      if (!cartOrderedDuringUpdate) {
        throw error
      }

      appLogger.info(
        { cartId: ctCart.id, briqpaySessionId, error: error instanceof Error ? error.message : error },
        'Cart no longer writable (ordered), skipping Briqpay session metadata write',
      )
    }
  }

  /**
   * Assigns the Briqpay custom type to a cart that has none and returns the cart version
   * produced by that update, which the follow-up field write must use.
   */
  private async setBriqpayCustomTypeOnCart(cart: Cart, briqpaySessionId: string): Promise<number> {
    // Get the actual type key (may be different from field name if we extended another type)
    const typeKey = await getBriqpayTypeKey()
    appLogger.info({ briqpaySessionId, typeKey }, 'Setting custom type for cart')
    const cartResponse = await apiRoot
      .carts()
      .withId({ ID: cart.id })
      .post({
        body: {
          version: cart.version,
          actions: [
            {
              action: 'setCustomType',
              type: {
                key: typeKey,
                typeId: 'type',
              },
            },
          ],
        },
      })
      .execute()

    // In order to get the correct version for the next call
    return cartResponse.body.version
  }

  /**
   * Derives the setCustomField actions needed to sync Briqpay session metadata onto the
   * cart. Only changed values produce actions, so a retry against a fresh cart snapshot
   * becomes a no-op when a concurrent writer already persisted the same metadata.
   */
  private buildSessionMetadataActions(
    cart: Cart,
    briqpaySessionId: string,
    futureOrderNumber?: string,
    checkoutTransactionItemId?: string,
  ): SetCustomFieldAction[] {
    const existingBriqpaySessionId = cart.custom?.fields?.[briqpaySessionIdFieldName]
    const existingFutureOrderNumber = cart.custom?.fields?.[briqpayFutureOrderNumberFieldName]
    const existingCheckoutTransactionItemId = cart.custom?.fields?.[briqpayCheckoutTransactionItemIdFieldName]

    const actions: SetCustomFieldAction[] = []

    if (existingBriqpaySessionId !== briqpaySessionId) {
      actions.push({
        action: 'setCustomField',
        name: briqpaySessionIdFieldName,
        value: briqpaySessionId,
      })
    }

    if (futureOrderNumber && !existingFutureOrderNumber) {
      actions.push({
        action: 'setCustomField',
        name: briqpayFutureOrderNumberFieldName,
        value: futureOrderNumber,
      })
    }

    // Overwrite-on-change (NOT write-once): the tag must track the ACTIVE Checkout session so the
    // webhook fallback creates a Payment linked to the current checkout. A stale tag from an
    // abandoned earlier entry would not link, blocking Order creation.
    if (checkoutTransactionItemId && existingCheckoutTransactionItemId !== checkoutTransactionItemId) {
      actions.push({
        action: 'setCustomField',
        name: briqpayCheckoutTransactionItemIdFieldName,
        value: checkoutTransactionItemId,
      })
    }

    return actions
  }

  /**
   * Probes whether the cart has been converted to an Order (buyer completed payment).
   * Only that state proves the metadata write is safely skippable. Any other state or a
   * failed probe (including the cart being gone) returns false so the caller's original
   * error propagates loudly instead of being swallowed on guesswork.
   */
  private async hasCartBeenOrdered(cartId: string): Promise<boolean> {
    try {
      const cart = await this.ctCartService.getCart({ id: cartId })

      return cart.cartState === 'Ordered'
    } catch {
      return false
    }
  }

  public async createOrUpdateBriqpaySession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    futureOrderNumber?: string,
  ): Promise<MediumBriqpayResponse> {
    const existingSessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName] as string
    appLogger.info({ existingSessionId }, 'Existing session ID:')

    try {
      if (existingSessionId) {
        const result = await this.manageExistingSession(
          ctCart,
          amountPlanned,
          hostname,
          existingSessionId,
          futureOrderNumber,
        )
        return result
      }

      appLogger.info({}, 'Creating new session')
      const briqpaySession = await Briqpay.createSession(
        ctCart as PlatformCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
      )
      appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session:')
      return briqpaySession
    } catch (error) {
      return this.handleSessionCreationFallback(ctCart, amountPlanned, hostname, error, futureOrderNumber)
    }
  }

  private async manageExistingSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    existingSessionId: string,
    futureOrderNumber?: string,
  ): Promise<MediumBriqpayResponse> {
    const briqpaySession = await Briqpay.getSession(existingSessionId)
    appLogger.info({ existingSessionId, hasHtmlSnippet: !!briqpaySession.htmlSnippet }, 'Retrieved Briqpay session')

    // If the session has active payment activity (e.g. user completed PayPal HPP flow),
    // return the existing session to avoid resetting the checkout after HPP redirect.
    const paymentStatus = briqpaySession.moduleStatus?.payment
    if (
      paymentStatus?.orderStatus === 'order_pending' ||
      paymentStatus?.orderStatus === 'order_approved_not_captured'
    ) {
      appLogger.info(
        { orderStatus: paymentStatus.orderStatus, uiStatus: paymentStatus.uiStatus },
        'Session has active payment in progress, reusing existing session',
      )
      if (!briqpaySession.htmlSnippet) {
        appLogger.error(
          { existingSessionId },
          'htmlSnippet missing from getSession despite requesting it - checkout iframe will fail to render',
        )
      }
      return briqpaySession
    }

    // Compare cart with session data
    const isCartMatching = await this.compareCartWithSession(ctCart, briqpaySession)
    appLogger.info({ isCartMatching }, 'Cart matching result:')

    if (isCartMatching) {
      return briqpaySession
    }

    return this.updateOrCreateSession(ctCart, amountPlanned, hostname, existingSessionId, futureOrderNumber)
  }

  private async updateOrCreateSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    existingSessionId: string,
    futureOrderNumber?: string,
  ): Promise<MediumBriqpayResponse> {
    try {
      appLogger.info({}, 'Updating session with new cart data')
      const briqpaySession = (await Briqpay.updateSession(
        existingSessionId,
        ctCart as PlatformCart,
        amountPlanned,
      )) as unknown as MediumBriqpayResponse
      appLogger.info({}, 'Updated session:')
      return briqpaySession
    } catch (updateError) {
      appLogger.error(
        { error: updateError instanceof Error ? updateError.message : updateError },
        'Failed to update Briqpay session, creating new one:',
      )
      const briqpaySession = await Briqpay.createSession(
        ctCart as PlatformCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
      )
      appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session after update failed:')
      return briqpaySession
    }
  }

  private async handleSessionCreationFallback(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    error: unknown,
    futureOrderNumber?: string,
  ): Promise<MediumBriqpayResponse> {
    // If session retrieval fails or no session exists, create a new one
    appLogger.error(
      { error: error instanceof Error ? error.message : error },
      'Session operation failed, creating new session:',
    )
    try {
      const briqpaySession = await Briqpay.createSession(
        ctCart as PlatformCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
      )
      appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session after error:')
      return briqpaySession
    } catch (creationError) {
      appLogger.error(
        { error: creationError instanceof Error ? creationError.message : creationError },
        'Failed to create Briqpay session:',
      )
      throw new SessionError('Failed to create Briqpay payment session')
    }
  }

  private async compareCartWithSession(ctCart: Cart, briqpaySession: MediumBriqpayResponse): Promise<boolean> {
    const sessionAmount = briqpaySession.data?.order?.amountIncVat
    const cartAmount = await this.ctCartService.getPaymentAmount({ cart: ctCart })

    appLogger.info(
      {
        sessionAmount,
        cartAmount: cartAmount.centAmount,
        ctCartId: ctCart.id,
        ctCartVersion: ctCart.version,
        ctCartLineItemCount: ctCart.lineItems.length,
        briqpaySessionId: briqpaySession.sessionId,
      },
      'Comparing cart with Briqpay session',
    )

    // Compare amounts
    if (sessionAmount !== cartAmount.centAmount) {
      appLogger.info(
        {
          sessionAmount,
          cartAmount: cartAmount.centAmount,
        },
        'Amounts do not match',
      )
      return false
    }

    // Compare order lines — filter out shipping, discount, and sales_tax items
    // that are added by the processor (addShippingItem/addDiscountItem) and not
    // present in ctCart.lineItems, to avoid false mismatches on HPP return.
    const NON_PRODUCT_TYPES = new Set(['shipping_fee', 'shipping_line', 'discount', 'sales_tax'])
    const allSessionItems = briqpaySession.data?.order?.cart || []
    const sessionItems = allSessionItems.filter(
      (item) => !('productType' in item && NON_PRODUCT_TYPES.has(String(item.productType))),
    )
    const cartItems = ctCart.lineItems

    // Custom line items are sent to Briqpay as product items too. Negative ones are
    // mapped to 'discount' which the NON_PRODUCT_TYPES filter above already excludes
    // from sessionItems, so exclude them here as well. Reusing the real mapper keeps
    // this comparison exactly in sync with what createSession/updateSession send.
    const customCartItems = ctCart.customLineItems
      .map((item) => mapCustomLineItem(item as CustomLineItem, ctCart.locale))
      .filter((item) => item.productType !== ITEM_PRODUCT_TYPE.DISCOUNT)

    if (sessionItems.length !== cartItems.length + customCartItems.length) {
      appLogger.info(
        {
          briqpayCartLength: sessionItems.length,
          allSessionCartLength: allSessionItems.length,
          ctCartLength: cartItems.length,
          ctCustomLineItemLength: customCartItems.length,
        },
        'Number of product items does not match',
      )
      return false
    }

    // Get the locale to use for item name comparison.
    // Fall back to 'en' or the first available key if cart locale is not set,
    // to avoid throwing and accidentally creating a new Briqpay session.
    const locale = ctCart.locale || 'en'

    // Compare each cart item with session items
    for (const cartItem of cartItems) {
      if (!this.isCartItemInSession(cartItem as LineItem, sessionItems, locale)) {
        appLogger.info({}, 'No matching session item found for cart item')
        return false
      }
    }

    // Compare each custom line item with session items (mapped vs mapped, so all
    // fields are directly comparable to what was originally sent to Briqpay)
    for (const customItem of customCartItems) {
      const hasMatch = sessionItems.some(
        (sessionItem) =>
          'unitPrice' in sessionItem &&
          sessionItem.name === customItem.name &&
          sessionItem.reference === customItem.reference &&
          sessionItem.quantity === customItem.quantity &&
          sessionItem.unitPrice === customItem.unitPrice &&
          sessionItem.taxRate === customItem.taxRate,
      )

      if (!hasMatch) {
        appLogger.info({}, 'No matching session item found for custom line item')
        return false
      }
    }

    return true
  }

  private isCartItemInSession(cartItem: LineItem, sessionItems: CartItem[], locale: string): boolean {
    const nameRecord = cartItem.name as Record<string, string>
    const cartItemName = nameRecord[locale] || nameRecord['en'] || Object.values(nameRecord)[0]
    if (!cartItemName) {
      return false
    }
    const cartItemId = cartItem.id

    // Find matching session item based on properties
    return !!sessionItems.find((sessionItem: CartItem) => {
      // Check if it's a sales tax item
      if (sessionItem.productType === 'sales_tax') {
        const cartTaxAmount = cartItem.taxedPrice?.totalGross?.centAmount ?? 0
        return (
          sessionItem.name === cartItemName &&
          sessionItem.reference === cartItemId &&
          sessionItem.totalTaxAmount === cartTaxAmount
        )
      }

      // Regular item comparison
      const cartUnitPrice = Math.round(
        (cartItem.taxedPrice?.totalNet?.centAmount ?? cartItem.price.value.centAmount) / cartItem.quantity,
      )
      const cartTaxRate = cartItem.taxRate?.amount

      return (
        sessionItem.name === cartItemName &&
        sessionItem.quantity === cartItem.quantity &&
        sessionItem.unitPrice === cartUnitPrice &&
        sessionItem.taxRate === cartTaxRate &&
        sessionItem.reference === cartItemId
      )
    })
  }
}
