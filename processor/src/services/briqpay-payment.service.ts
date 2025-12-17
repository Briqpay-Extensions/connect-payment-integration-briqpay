import { healthCheckCommercetoolsPermissions, statusHandler } from '@commercetools/connect-payments-sdk'
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
  DecisionRequestSchemaDTO,
  NotificationRequestSchemaDTO,
  PaymentResponseSchemaDTO,
} from '../dtos/briqpay-payment.dto'
import { getCartIdFromContext, getFutureOrderNumberFromContext } from '../libs/fastify/context/context'
import { TransactionDraftDTO, TransactionResponseDTO } from '../dtos/operations/transaction.dto'
import BriqpayService from '../libs/briqpay/BriqpayService'
import { BriqpaySessionService } from './briqpay/session.service'
import { BriqpayOperationService } from './briqpay/operation.service'
import { BriqpayNotificationService } from './briqpay/notification.service'
import { SessionError, UpstreamError, ValidationError } from '../libs/errors/briqpay-errors'

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

  public async config(hostname: string, clientOrigin?: string): Promise<ConfigResponse> {
    try {
      const config = getConfig()
      const cartId = getCartIdFromContext()
      const futureOrderNumber = getFutureOrderNumberFromContext()

      appLogger.info(
        {
          cartId,
          futureOrderNumber,
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

      // Check if a briqpay session id exists on the cart and handle session creation/retrieval
      appLogger.info({ futureOrderNumber, clientOrigin }, 'Creating Briqpay session with futureOrderNumber')
      const briqpaySession = await this.sessionService.createOrUpdateBriqpaySession(
        ctCart,
        amountPlanned,
        hostname,
        futureOrderNumber,
        clientOrigin,
      )

      // Ensure we have a valid session ID before updating the cart
      if (!briqpaySession?.sessionId) {
        appLogger.error({ briqpaySessionId: briqpaySession?.sessionId }, 'Invalid session response:')
        throw new SessionError('Invalid Briqpay session response: missing sessionId')
      }

      // Update the cart custom field if necessary
      await this.sessionService.updateCartWithBriqpaySessionId(ctCart, briqpaySession.sessionId)

      return {
        clientKey: config.mockClientKey,
        environment: config.mockEnvironment,
        snippet: briqpaySession.htmlSnippet,
        briqpaySessionId: briqpaySession.sessionId,
      }
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
          requiredPermissions: [
            'manage_payments',
            'view_sessions',
            'view_api_clients',
            'manage_orders',
            'introspect_oauth_tokens',
            'manage_checkout_payment_intents',
            'manage_types',
          ],
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
          type: 'embedded',
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
   * Makes a decision on a Briqpay session.
   * This is the secure server-side implementation that validates the session
   * belongs to the current cart before calling Briqpay's API.
   *
   * @param request - The decision request containing sessionId and decision
   * @returns Promise with success status and decision made
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
    const cartSessionId = ctCart.custom?.fields?.['briqpaySessionId'] as string | undefined

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

    // SECURITY: Call Briqpay's API server-side with proper authentication
    try {
      const response = await BriqpayService.makeDecision(sessionId, {
        decision,
        rejectionType,
        hardError,
        softErrors,
      })

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
          decision,
          status: response.status,
        },
        'Decision successfully sent to Briqpay',
      )

      return {
        success: true,
        decision,
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
