import { Cart, healthCheckCommercetoolsPermissions, statusHandler } from '@commercetools/connect-payments-sdk'
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  ConfigResponse,
  PaymentProviderModificationResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
  StatusResponse,
} from './types/operation.type'

import { SupportedPaymentComponentsSchemaDTO } from '../dtos/operations/payment-componets.dto'
import packageJSON from '../../package.json'

import { AbstractPaymentService } from './abstract-payment.service'
import { getConfig } from '../config/config'
import { appLogger, paymentSDK } from '../payment-sdk'
import { BriqpayPaymentServiceOptions, CreatePaymentRequest } from './types/briqpay-payment.type'
import {
  BRIQPAY_DECISION,
  BRIQPAY_REJECT_TYPE,
  BriqpayDecisionRequest,
  DecisionRequestSchemaDTO,
  NotificationRequestSchemaDTO,
  PaymentResponseSchemaDTO,
} from '../dtos/briqpay-payment.dto'
import {
  getCartIdFromContext,
  getCheckoutTransactionItemIdFromContext,
  getFutureOrderNumberFromContext,
} from '../libs/fastify/context/context'
import { TransactionDraftDTO, TransactionResponseDTO } from '../dtos/operations/transaction.dto'
import BriqpayService from '../libs/briqpay/BriqpayService'
import { BriqpaySessionService } from './briqpay/session.service'
import { BriqpayOperationService } from './briqpay/operation.service'
import { BriqpayNotificationService } from './briqpay/notification.service'
import { briqpaySessionAmountsEqual, readBriqpaySessionAmounts } from '../libs/briqpay/session-amounts'
import { SessionError, UpstreamError, ValidationError } from '../libs/errors/briqpay-errors'
import { briqpaySessionIdFieldName } from '../custom-types/custom-types'

const isDecisionAmountCheckDisabled = (): boolean => process.env.BRIQPAY_DISABLE_DECISION_AMOUNT_CHECK === 'true'

export class BriqpayPaymentService extends AbstractPaymentService {
  private sessionService: BriqpaySessionService
  private operationService: BriqpayOperationService
  private notificationService: BriqpayNotificationService

  constructor(opts: BriqpayPaymentServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService)
    this.sessionService = new BriqpaySessionService(opts.ctCartService)
    this.operationService = new BriqpayOperationService(opts.ctCartService, opts.ctPaymentService)
    this.notificationService = new BriqpayNotificationService(opts.ctPaymentService, this.operationService)
  }

  public async config(hostname: string): Promise<ConfigResponse> {
    try {
      const cartId = getCartIdFromContext()
      const futureOrderNumber = getFutureOrderNumberFromContext()
      const checkoutTransactionItemId = getCheckoutTransactionItemIdFromContext()

      appLogger.info(
        {
          cartId,
          futureOrderNumber,
          checkoutTransactionItemId,
          hostname,
        },
        'config called - checking for futureOrderNumber',
      )

      const ctCart = await this.ctCartService.getCart({
        id: cartId,
      })

      if (!ctCart.shippingAddress) {
        throw new ValidationError('Cart is missing a shipping address. Taxes cannot be calculated.')
      }

      if (!ctCart.billingAddress) {
        throw new ValidationError('Cart is missing a billing address. Taxes cannot be calculated.')
      }

      const amountPlanned = await this.ctCartService.getPlannedPaymentAmount({ cart: ctCart })

      appLogger.info(
        {
          totalPrice: ctCart.totalPrice,
          taxedPrice: ctCart.taxedPrice,
          discountOnTotalPrice: ctCart.discountOnTotalPrice,
          taxedShippingPrice: ctCart.taxedShippingPrice,
          version: ctCart.version,
        },
        'Cart amount details:',
      )

      // Resolve the Briqpay session for this cart: created, updated, or reused as-is
      appLogger.info({ futureOrderNumber }, 'Resolving Briqpay session with futureOrderNumber')
      const { session: briqpaySession, syncedPayloadHash } = await this.sessionService.resolveBriqpaySession(
        ctCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
      )

      // Ensure we have a valid session ID before updating the cart
      if (!briqpaySession?.sessionId) {
        appLogger.error({ briqpaySessionId: briqpaySession?.sessionId }, 'Invalid session response:')
        throw new SessionError('Invalid Briqpay session response: missing sessionId')
      }

      // Persist Briqpay session id + (write-once) futureOrderNumber on the cart so
      // the merchant backend can read futureOrderNumber back on subsequent checkout
      // entries instead of regenerating it. This keeps Briqpay reference1 aligned
      // with the eventual Order.orderNumber even when the customer returns after the
      // original CT Session has expired.
      // syncedPayloadHash is only set when Briqpay provably applied the payload, so a
      // reused-untouched session leaves the previously stored marker alone.
      await this.sessionService.updateCTCartWithBriqpaySession(ctCart, {
        briqpaySessionId: briqpaySession.sessionId,
        futureOrderNumber,
        checkoutTransactionItemId,
        syncedPayloadHash,
      })

      // Mirrored in enabler/src/payment-enabler/payment-enabler-briqpay.ts BriqpayConfigResponse
      const configResponse: ConfigResponse = {
        snippet: briqpaySession.htmlSnippet,
        briqpaySessionId: briqpaySession.sessionId,
      }

      return configResponse
    } catch (error) {
      appLogger.error(
        {
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Error in config:',
      )
      throw error
    }
  }

  public async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          requiredPermissions: ['manage_orders', 'manage_payments', 'manage_types', 'manage_sessions', 'view_orders'],
          ctAuthorizationService: paymentSDK.ctAuthorizationService,
          projectKey: getConfig().projectKey,
        }),
        async () => {
          try {
            const paymentMethods = 'briqpay'

            // Throws an exception if the API isn't healthy
            await BriqpayService.healthCheck()

            return {
              name: 'Briqpay Payment API',
              status: 'UP',
              message: 'Briqpay api is working',
              details: {
                paymentMethods,
              },
            }
          } catch (e) {
            return {
              name: 'Briqpay Payment API',
              status: 'DOWN',
              message: 'The Briqpay paymentAPI is down for some reason. Please check the logs for more details.',
              details: {
                error: e,
              },
            }
          }
        },
      ],
      metadataFn: async () =>
        Promise.resolve({
          name: packageJSON.name,
          description: packageJSON.description,
          '@commercetools/connect-payments-sdk': packageJSON.dependencies['@commercetools/connect-payments-sdk'],
        }),
    })()

    return handler.body
  }

  public async getSupportedPaymentComponents(): Promise<SupportedPaymentComponentsSchemaDTO> {
    return Promise.resolve({
      dropins: [
        {
          type: 'briqpay',
        },
      ],
      components: [],
    })
  }

  public processNotification(opts: {
    data: NotificationRequestSchemaDTO
    signatureHeader?: string
    rawBody?: string
  }): Promise<void> {
    return this.notificationService.processNotification(opts)
  }

  public capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.operationService.capturePayment(request)
  }

  public cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.operationService.cancelPayment(request)
  }

  public refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.operationService.refundPayment(request)
  }

  public reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.operationService.reversePayment(request)
  }

  public handleTransaction(transactionDraft: TransactionDraftDTO): Promise<TransactionResponseDTO> {
    return this.operationService.handleTransaction(transactionDraft)
  }

  public createPayment(request: CreatePaymentRequest): Promise<PaymentResponseSchemaDTO> {
    return this.operationService.createPayment(request)
  }

  /**
   * Best-effort re-sync of the Briqpay session to the cart, so the buyer's retry can
   * succeed after the reject (the widget rehydrates on resume). Never throws.
   *
   * Goes through the session service so the cart's stored hash is updated too: a PATCH
   * that left the old hash behind would let the next /config believe the session still
   * matches the cart, and skip the update that would have fixed it.
   */
  private async repairSessionFromCart(ctCart: Cart, sessionId: string): Promise<void> {
    try {
      const amountPlanned = await this.ctCartService.getPlannedPaymentAmount({ cart: ctCart })

      await this.sessionService.syncCTCartToBriqpaySession(ctCart, sessionId, amountPlanned)

      appLogger.info({ cartId: ctCart.id, sessionId }, 'Re-synced Briqpay session to cart after amount mismatch')
    } catch (error) {
      appLogger.error(
        {
          cartId: ctCart.id,
          sessionId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to re-sync Briqpay session after amount mismatch',
      )
    }
  }

  /** Fail-closed: any error or missing session amount counts as a mismatch. Never throws. */
  private async verifySessionAmountMatchesCart(ctCart: Cart, sessionId: string): Promise<boolean> {
    try {
      const briqpaySession = await BriqpayService.getSession(sessionId)
      // Same builder the sync paths use, so the expectation is exactly what a sync would send
      const cartAmount = await this.ctCartService.getPlannedPaymentAmount({ cart: ctCart })
      const update = await BriqpayService.buildSessionUpdateRequest(ctCart, cartAmount)

      if (!briqpaySessionAmountsEqual(briqpaySession, update.amounts)) {
        appLogger.error(
          {
            cartId: ctCart.id,
            sessionId,
            expected: update.amounts,
            actual: readBriqpaySessionAmounts(briqpaySession),
          },
          'Amount mismatch between Briqpay session and cart - potential security violation',
        )
        return false
      }

      return true
    } catch (error) {
      appLogger.error(
        {
          cartId: ctCart.id,
          sessionId,
          error: error instanceof Error ? error.message : error,
        },
        'Could not verify Briqpay session amount - failing closed with reject',
      )
      return false
    }
  }

  /**
   * Makes a decision on a Briqpay session.
   * This is the secure server-side implementation that validates the session
   * belongs to the current cart before calling Briqpay's API. An allow is only
   * forwarded if the session amount still matches the cart; on mismatch the
   * session is re-synced to the cart and a soft reject is sent instead.
   *
   * @param request - The decision request containing sessionId and decision
   * @returns the decision actually sent to Briqpay; success is false when it was overridden
   * @throws SessionError if session validation fails
   * @throws UpstreamError if Briqpay API call fails
   */
  public async makeDecision(
    request: DecisionRequestSchemaDTO,
  ): Promise<{ success: boolean; decision: BRIQPAY_DECISION }> {
    const { sessionId, decision, rejectionType, hardError, softErrors } = request
    const cartId = getCartIdFromContext()

    appLogger.info(
      {
        sessionId,
        decision,
        cartId,
      },
      'Processing makeDecision request',
    )

    // SECURITY: Validate that the session belongs to the cart from the authenticated context
    const ctCart = await this.ctCartService.getCart({ id: cartId })
    const cartSessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName] as string | undefined

    if (!cartSessionId) {
      appLogger.error({ cartId, sessionId }, 'Cart does not have a Briqpay session associated')
      throw new SessionError('No Briqpay session found for this cart', 400)
    }

    if (cartSessionId !== sessionId) {
      appLogger.error(
        {
          cartId,
          requestedSessionId: sessionId,
          cartSessionId,
        },
        'Session ID mismatch - potential security violation',
      )
      throw new SessionError('Session does not belong to this cart', 403)
    }

    // SECURITY: an allow that cannot be verified against the cart becomes a soft reject.
    // The session is re-synced first, so it must land before the reject resumes the widget.
    let outbound: BriqpayDecisionRequest = { decision, rejectionType, hardError, softErrors }
    if (
      decision === BRIQPAY_DECISION.ALLOW &&
      !isDecisionAmountCheckDisabled() &&
      !(await this.verifySessionAmountMatchesCart(ctCart, sessionId))
    ) {
      await this.repairSessionFromCart(ctCart, sessionId)
      outbound = {
        decision: BRIQPAY_DECISION.REJECT,
        rejectionType: BRIQPAY_REJECT_TYPE.NOTIFY_USER,
      }
    }

    // SECURITY: Call Briqpay's API server-side with proper authentication
    try {
      const response = await BriqpayService.makeDecision(sessionId, outbound)

      if (!response.ok) {
        const errorText = await response.text()
        appLogger.error(
          {
            status: response.status,
            statusText: response.statusText,
            errorText,
            sessionId,
          },
          'Briqpay makeDecision API call failed',
        )
        throw new UpstreamError(`Briqpay decision failed: ${response.status} ${response.statusText}`)
      }

      appLogger.info(
        {
          sessionId,
          requestedDecision: decision,
          decision: outbound.decision,
          status: response.status,
        },
        'Decision successfully sent to Briqpay',
      )

      return {
        success: outbound.decision === decision,
        decision: outbound.decision,
      }
    } catch (error) {
      if (error instanceof SessionError || error instanceof UpstreamError) {
        throw error
      }

      appLogger.error(
        {
          error: error instanceof Error ? error.message : error,
          sessionId,
        },
        'Unexpected error in makeDecision',
      )
      throw new UpstreamError('Failed to process decision', error)
    }
  }
}
