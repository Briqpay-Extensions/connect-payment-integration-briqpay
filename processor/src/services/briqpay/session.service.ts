import { Cart, CommercetoolsCartService } from '@commercetools/connect-payments-sdk'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import type { Cart as PlatformCart } from '@commercetools/platform-sdk'
import { LineItem } from '@commercetools/platform-sdk'
import { appLogger } from '../../payment-sdk'
import { CartItem, MediumBriqpayResponse } from '../types/briqpay-payment.type'
import Briqpay from '../../libs/briqpay/BriqpayService'
import { apiRoot } from '../../libs/commercetools/api-root'
import { SessionError } from '../../libs/errors/briqpay-errors'
import { getBriqpayTypeKey } from '../../connectors/actions'
import { briqpaySessionIdFieldName } from '../../custom-types/custom-types'

export class BriqpaySessionService {
  constructor(private readonly ctCartService: CommercetoolsCartService) {}

  /**
   * Updates the cart with Briqpay session id
   *
   * @param ctCart - The cart to attach the briqpay session id to
   * @param briqpaySessionId - Briqpay session id
   */
  public async updateCartWithBriqpaySessionId(ctCart: Cart, briqpaySessionId: string): Promise<void> {
    const existingBriqpaySessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName]

    let updatedCart = ctCart
    if (!ctCart.custom) {
      // Get the actual type key (may be different from field name if we extended another type)
      const typeKey = await getBriqpayTypeKey()
      appLogger.info({ briqpaySessionId, typeKey }, 'Setting custom type for cart')
      const cartResponse = await apiRoot
        .carts()
        .withId({ ID: ctCart.id })
        .post({
          body: {
            version: ctCart.version,
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
      updatedCart = cartResponse.body as unknown as Cart
    }

    // Only update it if we have a new session
    if (existingBriqpaySessionId !== briqpaySessionId) {
      appLogger.info({ briqpaySessionId }, 'Updating custom type field for cart')
      await apiRoot
        .carts()
        .withId({ ID: ctCart.id })
        .post({
          body: {
            version: updatedCart.version,
            actions: [
              {
                action: 'setCustomField',
                name: briqpaySessionIdFieldName,
                value: briqpaySessionId,
              },
            ],
          },
        })
        .execute()
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

    if (sessionItems.length !== cartItems.length) {
      appLogger.info(
        {
          briqpayCartLength: sessionItems.length,
          allSessionCartLength: allSessionItems.length,
          ctCartLength: cartItems.length,
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
