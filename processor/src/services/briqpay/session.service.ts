import { Cart, CommercetoolsCartService } from '@commercetools/connect-payments-sdk'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import type { Cart as PlatformCart } from '@commercetools/platform-sdk'
import { LineItem } from '@commercetools/platform-sdk'
import { appLogger } from '../../payment-sdk'
import { CartItem, MediumBriqpayResponse } from '../types/briqpay-payment.type'
import Briqpay from '../../libs/briqpay/BriqpayService'
import { apiRoot } from '../../libs/commercetools/api-root'
import { SessionError, ValidationError } from '../../libs/errors/briqpay-errors'

export class BriqpaySessionService {
  constructor(private readonly ctCartService: CommercetoolsCartService) {}

  /**
   * Updates the cart with Briqpay session id
   *
   * @param ctCart - The cart to attach the briqpay session id to
   * @param briqpaySessionId - Briqpay session id
   */
  public async updateCartWithBriqpaySessionId(ctCart: Cart, briqpaySessionId: string): Promise<void> {
    const briqpaySessionIdCustomFieldKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'
    const existingBriqpaySessionId = ctCart.custom?.fields?.[briqpaySessionIdCustomFieldKey]

    let updatedCart = ctCart
    if (!ctCart.custom) {
      appLogger.info({ briqpaySessionId }, 'Setting custom type for cart')
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
                  key: briqpaySessionIdCustomFieldKey,
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
                name: briqpaySessionIdCustomFieldKey,
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
    clientOrigin?: string,
  ): Promise<MediumBriqpayResponse> {
    const briqpaySessionIdCustomFieldKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'
    const existingSessionId = ctCart.custom?.fields?.[briqpaySessionIdCustomFieldKey] as string
    appLogger.info({ existingSessionId }, 'Existing session ID:')

    try {
      if (existingSessionId) {
        const result = await this.manageExistingSession(
          ctCart,
          amountPlanned,
          hostname,
          existingSessionId,
          futureOrderNumber,
          clientOrigin,
        )
        return result
      }

      appLogger.info({}, 'Creating new session')
      const briqpaySession = await Briqpay.createSession(
        ctCart as PlatformCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
        clientOrigin,
      )
      appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session:')
      return briqpaySession
    } catch (error) {
      return this.handleSessionCreationFallback(ctCart, amountPlanned, hostname, error, futureOrderNumber, clientOrigin)
    }
  }

  private async manageExistingSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    existingSessionId: string,
    futureOrderNumber?: string,
    clientOrigin?: string,
  ): Promise<MediumBriqpayResponse> {
    const briqpaySession = await Briqpay.getSession(existingSessionId)
    appLogger.info({ existingSessionId }, 'Retrieved Briqpay session:')

    // Compare cart with session data
    const isCartMatching = await this.compareCartWithSession(ctCart, briqpaySession)
    appLogger.info({ isCartMatching }, 'Cart matching result:')

    if (!isCartMatching) {
      return this.updateOrCreateSession(
        ctCart,
        amountPlanned,
        hostname,
        existingSessionId,
        futureOrderNumber,
        clientOrigin,
      )
    }

    return briqpaySession
  }

  private async updateOrCreateSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    existingSessionId: string,
    futureOrderNumber?: string,
    clientOrigin?: string,
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
        clientOrigin,
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
    clientOrigin?: string,
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
        clientOrigin,
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

    // Compare order lines
    const sessionItems = briqpaySession.data?.order?.cart || []
    const cartItems = ctCart.lineItems

    if (sessionItems.length !== cartItems.length) {
      appLogger.info(
        { briqpayCartLength: sessionItems.length, ctCartLength: cartItems.length },
        'Number of items does not match',
      )
      return false
    }

    // Get the locale to use
    // STRICT: No fallback to 'en' or first key. Locale must be present.
    if (!ctCart.locale) {
      throw new ValidationError('Cart is missing locale, cannot compare sessions accurately.')
    }
    const locale = ctCart.locale

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
    const cartItemName = cartItem.name[locale]
    if (!cartItemName) {
      // If name is missing in the specific locale, we might fail or try another.
      // But since we are strict, we should probably fail if the name for the locale is missing.
      // However, isCartItemInSession returns boolean.
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
