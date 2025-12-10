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
import {
  convertNotificationStatus,
  convertPaymentResultCode,
  getActualCaptureStatus,
  getActualOrderStatus,
  getActualRefundStatus,
  orderStatusToWebhookStatus,
  transactionStatusToWebhookStatus,
} from './utils'
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

  /**
   * Processes incoming webhook notifications from Briqpay.
   *
   * IMPORTANT: Webhook payloads are NOT trusted for status determination.
   * Instead, we use the webhook as a trigger and fetch the actual status from
   * Briqpay's API (moduleStatus, captures, refunds arrays) to determine the
   * real state. This protects against:
   *
   * 1. Spoofed webhooks - webhooks are currently unauthenticated
   * 2. Race conditions - webhooks may arrive out of order
   * 3. Failed webhooks - we get the actual state regardless of webhook reliability
   *
   * TODO: Once HMAC webhook validation is enabled on Briqpay's side, we can
   * optionally trust the webhook payload directly for better performance.
   * However, fetching the actual status is still recommended for critical
   * state transitions to handle race conditions.
   */
  public async processNotification(opts: { data: NotificationRequestSchemaDTO }): Promise<void> {
    const { sessionId: briqpaySessionId, event, captureId: briqpayCaptureId, refundId: briqpayRefundId } = opts.data

    // Note: We intentionally ignore opts.data.status from the webhook payload.
    // The actual status is fetched from Briqpay API to prevent spoofing and race conditions.
    appLogger.info({ ...opts.data }, 'Processing notification (webhook status will be verified against Briqpay API)')

    try {
      const briqpaySession = await this.fetchAndValidateSession(briqpaySessionId)

      const actualStatuses = this.extractActualStatuses(briqpaySession, briqpayCaptureId, briqpayRefundId)
      this.logActualStatuses(briqpaySessionId, event, opts.data.status, actualStatuses, briqpaySession)

      const payment = await this.ctPaymentService.findPaymentsByInterfaceId({
        interfaceId: briqpaySessionId,
      })

      await this.routeEventToHandler(event, payment, briqpaySession, actualStatuses, briqpayCaptureId, briqpayRefundId)
    } catch (e) {
      this.handleNotificationError(e, opts.data)
    }
  }

  /**
   * Fetches and validates the Briqpay session from the API.
   * This is the source of truth for status - webhook payloads are not trusted.
   */
  private async fetchAndValidateSession(briqpaySessionId: string): Promise<MediumBriqpayResponse> {
    const briqpaySession = await Briqpay.getSession(briqpaySessionId).catch((error) => {
      appLogger.warn(
        { briqpaySessionId, error: error instanceof Error ? error.message : error },
        'Failed to fetch session from Briqpay - potential spoofing attempt or invalid session',
      )
      return undefined
    })

    if (!briqpaySession || briqpaySession.sessionId !== briqpaySessionId) {
      appLogger.error(
        { briqpaySessionId, receivedSessionId: briqpaySession?.sessionId },
        'Webhook validation failed - session mismatch or not found',
      )
      throw new Error('Webhook validation failed: Invalid session')
    }

    return briqpaySession
  }

  /**
   * Extracts actual statuses from the Briqpay session response.
   */
  private extractActualStatuses(
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
  ) {
    return {
      orderStatus: getActualOrderStatus(briqpaySession),
      captureStatus: briqpayCaptureId ? getActualCaptureStatus(briqpaySession, briqpayCaptureId) : undefined,
      refundStatus: briqpayRefundId ? getActualRefundStatus(briqpaySession, briqpayRefundId) : undefined,
    }
  }

  /**
   * Logs the actual statuses fetched from Briqpay API for debugging.
   */
  private logActualStatuses(
    briqpaySessionId: string,
    webhookEvent: BRIQPAY_WEBHOOK_EVENT,
    webhookStatus: BRIQPAY_WEBHOOK_STATUS,
    actualStatuses: ReturnType<typeof this.extractActualStatuses>,
    briqpaySession: MediumBriqpayResponse,
  ): void {
    appLogger.info(
      {
        briqpaySessionId,
        webhookEvent,
        webhookStatus, // Log what webhook claimed (for debugging)
        actualOrderStatus: actualStatuses.orderStatus,
        actualCaptureStatus: actualStatuses.captureStatus,
        actualRefundStatus: actualStatuses.refundStatus,
        moduleStatus: briqpaySession.moduleStatus,
        capturesCount: briqpaySession.captures?.length ?? 0,
        refundsCount: briqpaySession.refunds?.length ?? 0,
      },
      'Fetched actual status from Briqpay API',
    )
  }

  /**
   * Routes the webhook event to the appropriate handler based on event type.
   */
  private async routeEventToHandler(
    event: BRIQPAY_WEBHOOK_EVENT,
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualStatuses: ReturnType<typeof this.extractActualStatuses>,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
  ): Promise<void> {
    switch (event) {
      case BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS:
        await this.processOrderStatusEvent(payment, briqpaySession, actualStatuses.orderStatus)
        break
      case BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS:
        await this.processCaptureStatusEvent(payment, briqpaySession, actualStatuses.captureStatus, briqpayCaptureId)
        break
      case BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS:
        await this.processRefundStatusEvent(payment, briqpaySession, actualStatuses.refundStatus, briqpayRefundId)
        break
    }
  }

  /**
   * Processes ORDER_STATUS webhook events using actual status from session.
   */
  private async processOrderStatusEvent(
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualOrderStatus: ReturnType<typeof getActualOrderStatus>,
  ): Promise<void> {
    if (!actualOrderStatus) {
      appLogger.warn({ briqpaySessionId: briqpaySession.sessionId }, 'No orderStatus found in moduleStatus, skipping')
      return
    }

    const orderWebhookStatus = orderStatusToWebhookStatus(actualOrderStatus)
    appLogger.info({ actualOrderStatus, orderWebhookStatus }, 'Processing order status from actual session state')

    const orderHandlers: Partial<Record<BRIQPAY_WEBHOOK_STATUS, () => Promise<void>>> = {
      [BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING]: () =>
        this.handleOrderPending(payment, briqpaySession, orderWebhookStatus),
      [BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED]: () =>
        this.handleOrderApproved(payment, briqpaySession, orderWebhookStatus),
    }

    const handler = orderHandlers[orderWebhookStatus]
    if (handler) {
      await handler()
    } else {
      appLogger.info(
        { briqpaySessionId: briqpaySession.sessionId, orderWebhookStatus },
        'Order rejected/cancelled - no CT update needed',
      )
    }
  }

  /**
   * Processes CAPTURE_STATUS webhook events using actual status from session.
   */
  private async processCaptureStatusEvent(
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualCaptureStatus: ReturnType<typeof getActualCaptureStatus>,
    briqpayCaptureId?: string,
  ): Promise<void> {
    if (!briqpayCaptureId) {
      appLogger.warn({ briqpaySessionId: briqpaySession.sessionId }, 'Capture webhook received without captureId')
      return
    }

    if (!actualCaptureStatus) {
      appLogger.warn(
        { briqpaySessionId: briqpaySession.sessionId, briqpayCaptureId },
        'Capture not found in session captures array, skipping',
      )
      return
    }

    const captureWebhookStatus = transactionStatusToWebhookStatus(actualCaptureStatus)
    appLogger.info(
      { actualCaptureStatus, captureWebhookStatus, briqpayCaptureId },
      'Processing capture status from actual session state',
    )

    const captureHandlers: Record<string, () => Promise<void>> = {
      [BRIQPAY_WEBHOOK_STATUS.PENDING]: () =>
        this.handleCapturePending(payment, briqpaySession, briqpayCaptureId, captureWebhookStatus),
      [BRIQPAY_WEBHOOK_STATUS.APPROVED]: () =>
        this.handleCaptureApproved(payment, briqpaySession, briqpayCaptureId, captureWebhookStatus),
      [BRIQPAY_WEBHOOK_STATUS.REJECTED]: () =>
        this.handleCaptureRejected(payment, briqpaySession, briqpayCaptureId, captureWebhookStatus),
    }

    const handler = captureHandlers[captureWebhookStatus]
    if (handler) {
      await handler()
    }
  }

  /**
   * Processes REFUND_STATUS webhook events using actual status from session.
   */
  private async processRefundStatusEvent(
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualRefundStatus: ReturnType<typeof getActualRefundStatus>,
    briqpayRefundId?: string,
  ): Promise<void> {
    if (!briqpayRefundId) {
      appLogger.warn({ briqpaySessionId: briqpaySession.sessionId }, 'Refund webhook received without refundId')
      return
    }

    if (!actualRefundStatus) {
      appLogger.warn(
        { briqpaySessionId: briqpaySession.sessionId, briqpayRefundId },
        'Refund not found in session refunds array, skipping',
      )
      return
    }

    const refundWebhookStatus = transactionStatusToWebhookStatus(actualRefundStatus)
    appLogger.info(
      { actualRefundStatus, refundWebhookStatus, briqpayRefundId },
      'Processing refund status from actual session state',
    )

    const refundHandlers: Record<string, () => Promise<void>> = {
      [BRIQPAY_WEBHOOK_STATUS.PENDING]: () =>
        this.handleRefundPending(payment, briqpaySession, briqpayRefundId, refundWebhookStatus),
      [BRIQPAY_WEBHOOK_STATUS.APPROVED]: () =>
        this.handleRefundApproved(payment, briqpaySession, briqpayRefundId, refundWebhookStatus),
      [BRIQPAY_WEBHOOK_STATUS.REJECTED]: () =>
        this.handleRefundRejected(payment, briqpaySession, briqpayRefundId, refundWebhookStatus),
    }

    const handler = refundHandlers[refundWebhookStatus]
    if (handler) {
      await handler()
    }
  }

  /**
   * Handles errors during notification processing.
   */
  private handleNotificationError(e: unknown, notificationData: NotificationRequestSchemaDTO): void {
    if (e instanceof Errorx && e.code === 'ResourceNotFound') {
      appLogger.info(
        { notification: JSON.stringify(notificationData) },
        'Payment not found hence accepting the notification',
      )
      return
    }

    appLogger.error({ error: e }, 'Error processing notification')
    throw e
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
