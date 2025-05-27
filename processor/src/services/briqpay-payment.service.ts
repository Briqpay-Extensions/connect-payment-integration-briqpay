import {
  Cart,
  ErrorInvalidOperation,
  Errorx,
  healthCheckCommercetoolsPermissions,
  Payment,
  statusHandler,
  TransactionState,
  TransactionType,
} from '@commercetools/connect-payments-sdk'
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
import { PaymentModificationStatus } from '../dtos/operations/payment-intents.dto'
import packageJSON from '../../package.json'

import { AbstractPaymentService } from './abstract-payment.service'
import { getConfig } from '../config/config'
import { appLogger, paymentSDK } from '../payment-sdk'
import {
  BriqpayPaymentServiceOptions,
  CartItem,
  CreatePaymentRequest,
  MediumBriqpayResponse,
} from './types/briqpay-payment.type'
import {
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  NotificationRequestSchemaDTO,
  PaymentMethodType,
  PaymentOutcome,
  PaymentRequestSchemaDTO,
  PaymentResponseSchemaDTO,
} from '../dtos/briqpay-payment.dto'
import { getCartIdFromContext, getPaymentInterfaceFromContext } from '../libs/fastify/context/context'
import { randomUUID } from 'crypto'
import { TransactionDraftDTO, TransactionResponseDTO } from '../dtos/operations/transaction.dto'
import Briqpay from '../libs/briqpay/BriqpayService'
import { briqpaySessionIdCustomType } from '../custom-types/custom-types'
import BriqpayService from '../libs/briqpay/BriqpayService'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'

export class BriqpayPaymentService extends AbstractPaymentService {
  constructor(opts: BriqpayPaymentServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService)
  }

  /**
   * Updates the cart with Briqpay session id
   *
   * @param ctCart - The cart to attach the briqpay session id to
   * @param briqpaySessionId - Briqpay session id
   */
  private async updateCartWithBriqpaySessionId(ctCart: Cart, briqpaySessionId: string): Promise<void> {
    const briqpaySessionIdCustomFieldKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'
    const existingBriqpaySessionId = ctCart.custom?.fields?.[briqpaySessionIdCustomFieldKey]

    let updatedCart = ctCart
    if (!ctCart.custom) {
      appLogger.info({ briqpaySessionId }, 'Setting custom type for: ')
      const cartResponse = await paymentSDK.ctAPI.client
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
      updatedCart = cartResponse.body
    }

    // Only update it if we have a new session
    if (existingBriqpaySessionId !== briqpaySessionId) {
      appLogger.info({ briqpaySessionId }, 'Updating custom type field for: ')
      await paymentSDK.ctAPI.client
        .carts()
        .withId({ ID: ctCart.id })
        .post({
          body: {
            version: updatedCart.version,
            actions: [
              {
                action: 'setCustomField',
                name: briqpaySessionIdCustomType.name,
                value: briqpaySessionId,
              },
            ],
          },
        })
        .execute()
    }
  }

  private async createOrUpdateBriqpaySession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
  ): Promise<MediumBriqpayResponse> {
    let briqpaySession
    const existingSessionId = ctCart.custom?.fields?.[briqpaySessionIdCustomType.name] as string
    appLogger.info({ existingSessionId }, 'Existing session ID:')

    try {
      if (existingSessionId) {
        briqpaySession = await Briqpay.getSession(existingSessionId)
        appLogger.info({ existingSessionId }, 'Retrieved Briqpay session:')

        // Compare cart with session data
        const isCartMatching = await this.compareCartWithSession(ctCart, briqpaySession)
        appLogger.info({ isCartMatching }, 'Cart matching result:')

        if (!isCartMatching) {
          // If cart doesn't match session, update the existing session
          try {
            appLogger.info({}, 'Updating session with new cart data')
            briqpaySession = await Briqpay.updateSession(ctCart, amountPlanned, existingSessionId)
            appLogger.info({}, 'Updated session:')
          } catch (updateError) {
            appLogger.error({ updateError }, 'Failed to update Briqpay session, creating new one:')
            briqpaySession = await Briqpay.createSession(ctCart, amountPlanned, hostname)
            appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session after update failed:')
          }
        }
      } else {
        appLogger.info({}, 'Creating new session')
        briqpaySession = await Briqpay.createSession(ctCart, amountPlanned, hostname)
        appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session:')
      }
    } catch (error) {
      // If session retrieval fails or no session exists, create a new one
      appLogger.error({ error }, 'Session operation failed, creating new session:')
      try {
        briqpaySession = await Briqpay.createSession(ctCart, amountPlanned, hostname)
        appLogger.info({ briqpaySessionId: briqpaySession.sessionId }, 'Created new session after error:')
      } catch (error) {
        appLogger.error({ error }, 'Failed to create Briqpay session:')
        throw new Error('Failed to create Briqpay payment session')
      }
    }

    return briqpaySession
  }

  /**
   * Get configurations
   *
   * @remarks
   * Implementation to provide mocking configuration information
   *
   * @returns Promise with mocking object containing configuration information
   */
  public async config(hostname: string): Promise<ConfigResponse> {
    const config = getConfig()
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    })

    if (!ctCart.shippingAddress) {
      throw new Error('Cart is missing a shipping address. Taxes cannot be calculated.')
    }
    if (!ctCart.billingAddress) {
      throw new Error('Cart is missing a billing address. Taxes cannot be calculated.')
    }

    try {
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
      const briqpaySession = await this.createOrUpdateBriqpaySession(ctCart, amountPlanned, hostname)

      // Ensure we have a valid session ID before updating the cart
      if (!briqpaySession?.sessionId) {
        appLogger.error(briqpaySession, 'Invalid session response:')
        throw new Error('Invalid Briqpay session response: missing sessionId')
      }

      // Update the cart custom field if necessary
      await this.updateCartWithBriqpaySessionId(ctCart, briqpaySession.sessionId)

      return {
        clientKey: config.mockClientKey,
        environment: config.mockEnvironment,
        snippet: briqpaySession.htmlSnippet,
        briqpaySessionId: briqpaySession.sessionId,
      }
    } catch (error) {
      appLogger.error({ error }, 'Error in config:')
      return {
        error,
      }
    }
  }

  /**
   * Get status
   *
   * @remarks
   * Implementation to provide mocking status of external systems
   *
   * @returns Promise with mocking data containing a list of status from different external systems
   */
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

  /**
   * Get supported payment components
   *
   * @remarks
   * Implementation to provide the mocking payment components supported by the processor.
   *
   * @returns Promise with mocking data containing a list of supported payment components
   */
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

  // Helper function to update pending authorization to success
  private updatePendingAuthorization = async (payment: Payment[], briqpaySessionId: string) => {
    const pendingAuthorization = payment[0].transactions.find(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Pending',
    )

    if (pendingAuthorization) {
      await this.ctPaymentService.updatePayment({
        id: payment[0].id,
        transaction: {
          type: 'Authorization',
          interactionId: briqpaySessionId,
          amount: pendingAuthorization.amount,
          state: 'Success',
        },
      })
      appLogger.info({ briqpaySessionId }, 'Updated pending authorization to success')
    }
  }

  private handleOrderPending = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const alreadyAuthorized = payment?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Success',
    )

    if (alreadyAuthorized) {
      appLogger.info({ briqpaySessionId }, 'Authorization transaction already exists, skipping update.')
      return
    }

    // If no authorization exist but a hook is sent, create a payment
    if (!payment.length) {
      await this.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: this.convertPaymentResultCode(
            status as unknown as PaymentOutcome,
          ) as unknown as PaymentOutcome,
        },
      })
      return
    }

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Authorization',
        interactionId: briqpaySessionId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleOrderApproved = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const alreadyAuthorized = payment?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Success',
    )

    if (alreadyAuthorized) {
      appLogger.info({ briqpaySessionId }, 'Authorization transaction already exists, skipping update.')
      return
    }

    // If no authorization exist but a hook is sent, create a payment
    if (!payment.length) {
      await this.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: this.convertPaymentResultCode(
            status as unknown as PaymentOutcome,
          ) as unknown as PaymentOutcome,
        },
      })
      return
    }

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Authorization',
        interactionId: briqpaySessionId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleCapturePending = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const alreadyCharged = payment?.[0]?.transactions.some(
      (tx) =>
        tx.type === 'Charge' && tx.interactionId === briqpayCaptureId && ['Success', 'Pending'].includes(tx.state),
    )

    if (alreadyCharged) {
      appLogger.info({ briqpaySessionId }, 'Charge transaction already exists, skipping update.')
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Need to store briqpayCaptureId somehwere
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
        briqpayCaptureId,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleCaptureApproved = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleCaptureRejected = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    // TODO: Too quick capture resulted in no captureId/interactionId, so a failed captures gets its own row, need to tie them together
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleRefundPending = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId

    const alreadyRefunded = payment?.[0]?.transactions.some(
      (tx) => tx.type === 'Refund' && tx.interactionId === briqpayRefundId && ['Success', 'Pending'].includes(tx.state),
    )

    if (alreadyRefunded) {
      appLogger.info({ briqpaySessionId }, 'Refund transaction already exists, skipping update.')
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Need to store briqpayCaptureId somehwere
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
        briqpayRefundId,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleRefundApproved = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  private handleRefundRejected = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: this.convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  public async processNotification(opts: { data: NotificationRequestSchemaDTO }): Promise<void> {
    const {
      sessionId: briqpaySessionId,
      event,
      status,
      captureId: briqpayCaptureId,
      refundId: briqpayRefundId,
    } = opts.data

    appLogger.info({ ...opts.data }, 'Processing notification')

    try {
      // Authenticate towards Briqpay and fetch the session using the API scope in the Briqpay API keys
      const briqpaySession = await Briqpay.getSession(briqpaySessionId).catch(() => void 0)

      if (briqpaySession?.sessionId !== briqpaySessionId) {
        throw new Error('Briqpay session validation failed')
      }

      const payment = await this.ctPaymentService.findPaymentsByInterfaceId({
        interfaceId: briqpaySessionId,
      })

      switch (event) {
        case BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS: {
          switch (status) {
            case BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING: {
              await this.handleOrderPending(payment, briqpaySession, status)
              break
            }
            case BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED: {
              await this.handleOrderApproved(payment, briqpaySession, status)
              break
            }
          }
          break
        }

        case BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS: {
          switch (status) {
            case BRIQPAY_WEBHOOK_STATUS.PENDING: {
              await this.handleCapturePending(payment, briqpaySession, briqpayCaptureId!, status)
              break
            }

            case BRIQPAY_WEBHOOK_STATUS.APPROVED: {
              await this.handleCaptureApproved(payment, briqpaySession, briqpayCaptureId!, status)
              break
            }

            case BRIQPAY_WEBHOOK_STATUS.REJECTED: {
              await this.handleCaptureRejected(payment, briqpaySession, briqpayCaptureId!, status)
              break
            }
          }
          break
        }

        case BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS: {
          switch (status) {
            case BRIQPAY_WEBHOOK_STATUS.PENDING: {
              await this.handleRefundPending(payment, briqpaySession, briqpayRefundId!, status)
              break
            }

            case BRIQPAY_WEBHOOK_STATUS.APPROVED: {
              await this.handleRefundApproved(payment, briqpaySession, briqpayRefundId!, status)
              break
            }

            case BRIQPAY_WEBHOOK_STATUS.REJECTED: {
              await this.handleRefundRejected(payment, briqpaySession, briqpayRefundId!, status)
              break
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof Errorx && e.code === 'ResourceNotFound') {
        appLogger.info(
          {
            notification: JSON.stringify(opts.data),
          },
          'Payment not found hence accepting the notification',
        )
        return
      }

      appLogger.error({ error: e }, 'Error processing notification')
      throw e
    }
  }

  /**
   * Capture payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment capture in external PSPs
   *
   * @param request - contains the amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    if (!briqpaySessionId) {
      throw new Error('Cannot find briqpay session')
    }

    const captureExists = request.payment.transactions.some((tx) => tx.type === 'Charge' && tx.state !== 'Failure')
    if (captureExists) {
      throw new Error('Already captured')
    }

    const ctCart = await this.ctCartService.getCartByPaymentId({
      paymentId: request.payment.id,
    })

    if (request.amount?.centAmount !== (ctCart.taxedPrice?.totalGross?.centAmount ?? ctCart.totalPrice.centAmount)) {
      throw new Error('Commerce Tools does not support partial captures towards all payment providers')
    }

    const briqpayCapture = await Briqpay.capture(ctCart, request.payment.amountPlanned, briqpaySessionId)

    // Update pending authorization to success if needed
    const pendingAuthorization = request.payment.transactions.find(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Pending',
    )

    if (pendingAuthorization) {
      await this.ctPaymentService.updatePayment({
        id: request.payment.id,
        transaction: {
          type: 'Authorization',
          interactionId: briqpaySessionId,
          amount: pendingAuthorization.amount,
          state: this.convertPaymentResultCode(PaymentOutcome.APPROVED),
        },
      })
    }

    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Charge',
        amount: request.amount,
        state: this.convertPaymentResultCode(briqpayCapture.status),
        interactionId: briqpayCapture.captureId,
      },
    })

    return {
      outcome: this.convertPaymentModificationStatusCode(briqpayCapture.status),
      pspReference: request.payment.interfaceId as string,
    }
  }

  /**
   * Cancel payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment cancel in external PSPs
   *
   * @param request - contains {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    if (!briqpaySessionId) {
      throw new Error('Cannot find briqpay session')
    }

    // Check if there's already a successful capture
    const hasCapture = request.payment.transactions.some((tx) => tx.type === 'Charge' && tx.state === 'Success')
    if (hasCapture) {
      throw new Error('Cannot cancel a payment that has been captured')
    }

    try {
      const cancelResult = await Briqpay.cancel(briqpaySessionId)

      await this.ctPaymentService.updatePayment({
        id: request.payment.id,
        transaction: {
          type: 'CancelAuthorization',
          amount: request.payment.amountPlanned,
          state: this.convertPaymentResultCode(cancelResult.status),
        },
      })

      return {
        outcome: this.convertPaymentModificationStatusCode(cancelResult.status),
        pspReference: request.payment.interfaceId as string,
      }
    } catch (error) {
      appLogger.error({ error }, 'Failed to cancel Briqpay payment:')
      throw error
    }
  }

  /**
   * Refund payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment refund in external PSPs
   *
   * @param request - contains amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    if (!briqpaySessionId) {
      throw new Error('Cannot find briqpay session')
    }

    const existingCapture = request.payment.transactions.find((tx) => tx.type === 'Charge' && tx.state === 'Success')
    if (!existingCapture) {
      throw new Error('Must have a successful capture first')
    }

    const refundExists = request.payment.transactions.some((tx) => tx.type === 'Refund' && tx.state !== 'Failure')
    if (refundExists) {
      throw new Error('Already refunded')
    }

    const ctCart = await this.ctCartService.getCartByPaymentId({
      paymentId: request.payment.id,
    })

    if (request.amount?.centAmount !== (ctCart.taxedPrice?.totalGross?.centAmount ?? ctCart.totalPrice.centAmount)) {
      throw new Error('Commerce Tools does not support partial refunds towards all payment providers')
    }

    const briqpayRefund = await Briqpay.refund(
      ctCart,
      request.payment.amountPlanned,
      briqpaySessionId,
      existingCapture.interactionId,
    )

    // Update pending authorization to success if needed
    const pendingAuthorization = request.payment.transactions.find(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Pending',
    )

    if (pendingAuthorization) {
      await this.ctPaymentService.updatePayment({
        id: request.payment.id,
        transaction: {
          type: 'Authorization',
          interactionId: briqpaySessionId,
          amount: pendingAuthorization.amount,
          state: this.convertPaymentResultCode(PaymentOutcome.APPROVED),
        },
      })
    }

    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Refund',
        amount: request.amount,
        state: this.convertPaymentResultCode(briqpayRefund.status),
        interactionId: briqpayRefund.refundId,
      },
    })
    return {
      outcome: this.convertPaymentModificationStatusCode(briqpayRefund.status),
      pspReference: request.payment.interfaceId as string,
    }
  }

  /**
   * Reverse payment
   *
   * @remarks
   * Abstract method to execute payment reversals in support of automated reversals to be triggered by checkout api. The actual invocation to PSPs should be implemented in subclasses
   *
   * @param request
   * @returns Promise with outcome containing operation status and PSP reference
   */
  public async reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    const hasCharge = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Charge',
      states: ['Success'],
    })
    const hasRefund = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Refund',
      states: ['Success', 'Pending'],
    })
    const hasCancelAuthorization = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'CancelAuthorization',
      states: ['Success', 'Pending'],
    })

    const wasPaymentReverted = hasRefund || hasCancelAuthorization

    // If payment has been captured (hasCharge) and not yet refunded, use refund
    if (hasCharge && !wasPaymentReverted) {
      return this.refundPayment({
        payment: request.payment,
        merchantReference: request.merchantReference,
        amount: request.payment.amountPlanned,
      })
    }

    // If payment has been authorized but not captured, and not yet cancelled, use cancel
    const hasAuthorization = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Authorization',
      states: ['Success'],
    })
    if (hasAuthorization && !wasPaymentReverted) {
      return this.cancelPayment({ payment: request.payment })
    }

    throw new ErrorInvalidOperation('There is no successful payment transaction to reverse.')
  }

  /**
   * Create payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment creation in external PSPs
   *
   * @param request - contains paymentType defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async createPayment(request: CreatePaymentRequest): Promise<PaymentResponseSchemaDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    })

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned: await this.ctCartService.getPaymentAmount({
        cart: ctCart,
      }),
      paymentMethodInfo: {
        paymentInterface: getPaymentInterfaceFromContext() || 'Briqpay',
      },
      ...(ctCart.customerId && {
        customer: {
          typeId: 'customer',
          id: ctCart.customerId,
        },
      }),
      ...(!ctCart.customerId &&
        ctCart.anonymousId && {
          anonymousId: ctCart.anonymousId,
        }),
    })

    await this.ctCartService.addPayment({
      resource: {
        id: ctCart.id,
        version: ctCart.version,
      },
      paymentId: ctPayment.id,
    })

    const pspReference = ctCart.custom?.fields?.[briqpaySessionIdCustomType.name]

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: pspReference,
      paymentMethod: request.data.paymentMethod.type,
      transaction: {
        type: 'Authorization',
        amount: ctPayment.amountPlanned,
        interactionId: pspReference,
        state: this.convertPaymentResultCode(request.data.paymentOutcome),
      },
    })

    return {
      paymentReference: updatedPayment.id,
    }
  }

  public async handleTransaction(transactionDraft: TransactionDraftDTO): Promise<TransactionResponseDTO> {
    const TRANSACTION_AUTHORIZATION_TYPE: TransactionType = 'Authorization'
    const TRANSACTION_STATE_SUCCESS: TransactionState = 'Success'
    const TRANSACTION_STATE_FAILURE: TransactionState = 'Failure'

    const maxCentAmountIfSuccess = 10000

    const ctCart = await this.ctCartService.getCart({ id: transactionDraft.cartId })

    let amountPlanned = transactionDraft.amount
    if (!amountPlanned) {
      amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart })
    }

    const isBelowSuccessStateThreshold = amountPlanned.centAmount < maxCentAmountIfSuccess

    const newlyCreatedPayment = await this.ctPaymentService.createPayment({
      amountPlanned,
      paymentMethodInfo: {
        paymentInterface: transactionDraft.paymentInterface,
      },
    })

    await this.ctCartService.addPayment({
      resource: {
        id: ctCart.id,
        version: ctCart.version,
      },
      paymentId: newlyCreatedPayment.id,
    })

    const transactionState: TransactionState = isBelowSuccessStateThreshold
      ? TRANSACTION_STATE_SUCCESS
      : TRANSACTION_STATE_FAILURE

    const pspReference = randomUUID().toString()

    await this.ctPaymentService.updatePayment({
      id: newlyCreatedPayment.id,
      pspReference: pspReference,
      transaction: {
        amount: amountPlanned,
        type: TRANSACTION_AUTHORIZATION_TYPE,
        state: transactionState,
        interactionId: pspReference,
      },
    })

    if (isBelowSuccessStateThreshold) {
      return {
        transactionStatus: {
          errors: [],
          state: 'Pending',
        },
      }
    } else {
      return {
        transactionStatus: {
          errors: [
            {
              code: 'PaymentRejected',
              message: `Payment '${newlyCreatedPayment.id}' has been rejected.`,
            },
          ],
          state: 'Failed',
        },
      }
    }
  }

  private convertNotificationStatus(resultCode: BRIQPAY_WEBHOOK_STATUS): TransactionState {
    switch (resultCode) {
      case BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED:
      case BRIQPAY_WEBHOOK_STATUS.APPROVED:
        return 'Success'
      case BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING:
      case BRIQPAY_WEBHOOK_STATUS.PENDING:
        return 'Pending'
      case BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED:
      case BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED:
      case BRIQPAY_WEBHOOK_STATUS.REJECTED:
        return 'Failure'
      default:
        return 'Pending'
    }
  }

  private convertPaymentResultCode(resultCode: PaymentOutcome): string {
    switch (resultCode) {
      case PaymentOutcome.APPROVED:
        return 'Success'
      case PaymentOutcome.PENDING:
        return 'Pending'
      case PaymentOutcome.REJECTED:
        return 'Failure'
      default:
        return 'Pending'
    }
  }

  private convertPaymentModificationStatusCode(resultCode: PaymentOutcome): PaymentModificationStatus {
    switch (resultCode) {
      case PaymentOutcome.APPROVED:
        return PaymentModificationStatus.APPROVED
      case PaymentOutcome.PENDING:
        return PaymentModificationStatus.RECEIVED
      case PaymentOutcome.REJECTED:
        return PaymentModificationStatus.REJECTED
      default:
        return PaymentModificationStatus.RECEIVED
    }
  }

  private async compareCartWithSession(ctCart: Cart, briqpaySession: MediumBriqpayResponse): Promise<boolean> {
    const sessionAmount = briqpaySession.data?.order?.amountIncVat
    const cartAmount = await this.ctCartService.getPaymentAmount({ cart: ctCart })

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

    // Get the locale to use, with fallbacks
    const locale = ctCart.locale || Object.keys(cartItems[0]?.name || {})[0] || 'en'

    // Compare each cart item with session items
    for (const cartItem of cartItems) {
      const cartItemName = cartItem.name[locale]
      const cartItemId = cartItem.id

      // Find matching session item based on properties
      const matchingSessionItem = sessionItems.find((sessionItem: CartItem) => {
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

      if (!matchingSessionItem) {
        appLogger.info({}, 'No matching session item found for cart item')
        return false
      }
    }

    return true
  }
}
