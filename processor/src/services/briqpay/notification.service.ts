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

export class BriqpayNotificationService {
  constructor(
    private readonly ctPaymentService: CommercetoolsPaymentService,
    private readonly operationService: BriqpayOperationService,
  ) {}

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
}
