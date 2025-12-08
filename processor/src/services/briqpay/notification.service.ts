import { CommercetoolsPaymentService, Errorx, Payment } from '@commercetools/connect-payments-sdk'
import {
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  NotificationRequestSchemaDTO,
  PaymentMethodType,
  PaymentOutcome,
  PaymentRequestSchemaDTO,
} from '../../dtos/briqpay-payment.dto'
import { MediumBriqpayResponse } from '../types/briqpay-payment.type'
import { appLogger } from '../../payment-sdk'
import Briqpay from '../../libs/briqpay/BriqpayService'
import { convertNotificationStatus, convertPaymentResultCode } from './utils'
import { BriqpayOperationService } from './operation.service'
import { BriqpaySessionDataService } from './session-data.service'
import { apiRoot } from '../../libs/commercetools/api-root'
import { Order } from '@commercetools/platform-sdk'

export class BriqpayNotificationService {
  private readonly sessionDataService: BriqpaySessionDataService

  constructor(
    private readonly ctPaymentService: CommercetoolsPaymentService,
    private readonly operationService: BriqpayOperationService,
  ) {
    this.sessionDataService = new BriqpaySessionDataService()
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
      await this.operationService.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: convertPaymentResultCode(status as unknown as PaymentOutcome) as unknown as PaymentOutcome,
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
        state: convertNotificationStatus(status),
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

    // If no authorization exist but a hook is sent, create a payment
    if (!payment.length) {
      await this.operationService.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: convertPaymentResultCode(status as unknown as PaymentOutcome) as unknown as PaymentOutcome,
        },
      })
      return
    }

    // Update authorization to Success if not already done
    if (!alreadyAuthorized) {
      const updatedPayment = await this.ctPaymentService.updatePayment({
        id: payment[0].id,
        transaction: {
          type: 'Authorization',
          interactionId: briqpaySessionId,
          amount: {
            centAmount: briqpaySession.data!.order!.amountIncVat,
            currencyCode: briqpaySession.data!.order!.currency,
          },
          state: convertNotificationStatus(status),
        },
      })

      appLogger.info(
        {
          updatedPayment,
        },
        'Payment updated after processing the notification',
      )
    } else {
      appLogger.info({ briqpaySessionId }, 'Authorization transaction already exists, skipping transaction update.')
    }

    // Always attempt to ingest Briqpay session data to order custom fields
    // This is done regardless of whether the authorization was updated, as the order
    // may have been created after the initial authorization
    await this.ingestSessionDataToOrder(briqpaySessionId, payment[0].id)
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
        state: convertNotificationStatus(status),
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
    // eslint-disable-next-line no-console
    console.log('>>> handleCaptureApproved called', { briqpaySessionId, briqpayCaptureId })
    appLogger.info({ briqpaySessionId, briqpayCaptureId, paymentId: payment[0]?.id }, 'handleCaptureApproved called')

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
        state: convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )

    // Ingest Briqpay session data to order custom fields
    await this.ingestSessionDataToOrder(briqpaySessionId, payment[0].id)
  }

  private handleCaptureRejected = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: {
          centAmount: briqpaySession.data!.order!.amountIncVat,
          currencyCode: briqpaySession.data!.order!.currency,
        },
        state: convertNotificationStatus(status),
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
        state: convertNotificationStatus(status),
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
        state: convertNotificationStatus(status),
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
        state: convertNotificationStatus(status),
      },
    })

    appLogger.info(
      {
        updatedPayment,
      },
      'Payment updated after processing the notification',
    )
  }

  /**
   * Finds the order associated with a payment and ingests Briqpay session data to order custom fields.
   * This is a best-effort operation - failures are logged but do not fail the notification processing.
   *
   * @param briqpaySessionId - The Briqpay session ID
   * @param paymentId - The CommerceTools payment ID
   */
  private ingestSessionDataToOrder = async (briqpaySessionId: string, paymentId: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('>>> ingestSessionDataToOrder called', { briqpaySessionId, paymentId })
    appLogger.info({ briqpaySessionId, paymentId }, 'Starting ingestSessionDataToOrder lookup')

    try {
      // Find the order that contains this payment
      const ordersResponse = await apiRoot
        .orders()
        .get({
          queryArgs: {
            where: `paymentInfo(payments(id="${paymentId}"))`,
            limit: 1,
          },
        })
        .execute()

      const orders: Order[] = ordersResponse.body.results
      appLogger.info({ paymentId, briqpaySessionId, orderCount: orders.length }, 'Order lookup completed')

      if (orders.length === 0) {
        appLogger.info(
          { paymentId, briqpaySessionId },
          'No order found for payment, skipping session data ingestion (order may not be created yet)',
        )
        return
      }

      const order = orders[0]
      appLogger.info(
        { orderId: order.id, paymentId, briqpaySessionId, orderVersion: order.version, hasCustom: !!order.custom },
        'Found order for payment, starting session data ingestion',
      )

      // Ingest the session data to the order
      await this.sessionDataService.ingestSessionDataToOrder(briqpaySessionId, order.id)
    } catch (error) {
      // Log the error but don't fail the notification processing
      // The session data ingestion is a best-effort operation
      appLogger.error(
        {
          briqpaySessionId,
          paymentId,
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to ingest Briqpay session data to order (non-fatal)',
      )
    }
  }
}
