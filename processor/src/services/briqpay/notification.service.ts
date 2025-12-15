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
  getActualAuthorizationStatus,
  getActualCaptureStatus,
  getActualOrderStatus,
  getActualRefundStatus,
  getCapture,
  getRefund,
  getTransaction,
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
   * Uses data.transactions for authorization, data.captures for captures, data.refunds for refunds.
   */
  private extractActualStatuses(
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
  ) {
    return {
      orderStatus: getActualOrderStatus(briqpaySession),
      authorizationStatus: getActualAuthorizationStatus(briqpaySession),
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
        actualAuthorizationStatus: actualStatuses.authorizationStatus,
        actualCaptureStatus: actualStatuses.captureStatus,
        actualRefundStatus: actualStatuses.refundStatus,
        moduleStatus: briqpaySession.moduleStatus,
        transactionsCount: briqpaySession.data?.transactions?.length ?? 0,
        capturesCount: briqpaySession.data?.captures?.length ?? 0,
        refundsCount: briqpaySession.data?.refunds?.length ?? 0,
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
        await this.processOrderStatusEvent(payment, briqpaySession, actualStatuses)
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
   * Uses data.transactions[0].status for authorization status (pending/approved).
   */
  private async processOrderStatusEvent(
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualStatuses: ReturnType<typeof this.extractActualStatuses>,
  ): Promise<void> {
    const { orderStatus, authorizationStatus } = actualStatuses

    // Prefer authorization status from transactions array if available
    // This gives us pending/approved directly from the transaction
    if (authorizationStatus) {
      const authWebhookStatus = transactionStatusToWebhookStatus(authorizationStatus)
      appLogger.info(
        { authorizationStatus, authWebhookStatus },
        'Processing authorization status from data.transactions',
      )

      const authHandlers: Partial<Record<BRIQPAY_WEBHOOK_STATUS, () => Promise<void>>> = {
        [BRIQPAY_WEBHOOK_STATUS.PENDING]: () => this.handleAuthorizationPending(payment, briqpaySession),
        [BRIQPAY_WEBHOOK_STATUS.APPROVED]: () => this.handleAuthorizationApproved(payment, briqpaySession),
        [BRIQPAY_WEBHOOK_STATUS.REJECTED]: () => this.handleAuthorizationRejected(payment, briqpaySession),
      }

      const handler = authHandlers[authWebhookStatus]
      if (handler) {
        await handler()
        return
      }
    }

    // Fallback to moduleStatus.payment.orderStatus if no transactions
    if (!orderStatus) {
      appLogger.warn(
        { briqpaySessionId: briqpaySession.sessionId },
        'No authorization status in transactions and no orderStatus in moduleStatus, skipping',
      )
      return
    }

    const orderWebhookStatus = orderStatusToWebhookStatus(orderStatus)
    appLogger.info({ orderStatus, orderWebhookStatus }, 'Processing order status from moduleStatus (fallback)')

    const orderHandlers: Partial<Record<BRIQPAY_WEBHOOK_STATUS, () => Promise<void>>> = {
      [BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING]: () => this.handleAuthorizationPending(payment, briqpaySession),
      [BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED]: () =>
        this.handleAuthorizationApproved(payment, briqpaySession),
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

  /**
   * Handles Authorization Pending status.
   * Maps to CT Transaction Type: Authorization with state: Pending
   */
  private handleAuthorizationPending = async (payment: Payment[], briqpaySession: MediumBriqpayResponse) => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    const alreadyExists = payment?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId,
    )

    if (alreadyExists) {
      appLogger.info({ briqpaySessionId }, 'Authorization transaction already exists, skipping update.')
      return
    }

    // If no payment exists but a hook is sent, create a payment
    if (!payment.length) {
      await this.operationService.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: PaymentOutcome.PENDING,
        },
      })
      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Authorization',
        interactionId: briqpaySessionId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Pending',
      },
    })

    appLogger.info({ updatedPayment, transactionId: transaction?.transactionId }, 'Created Authorization Pending')
  }

  /**
   * Handles Authorization Approved status.
   * Maps to CT Transaction Type: Authorization with state: Success
   */
  private handleAuthorizationApproved = async (payment: Payment[], briqpaySession: MediumBriqpayResponse) => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    const alreadySuccessful = payment?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Success',
    )

    // If no payment exists but a hook is sent, create a payment
    if (!payment.length) {
      await this.operationService.createPayment({
        data: {
          paymentMethod: PaymentMethodType.BRIQPAY as unknown as PaymentRequestSchemaDTO['paymentMethod'],
          briqpaySessionId,
          paymentOutcome: PaymentOutcome.APPROVED,
        },
      })
      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    // Update authorization to Success if not already done
    if (!alreadySuccessful) {
      const updatedPayment = await this.ctPaymentService.updatePayment({
        id: payment[0].id,
        transaction: {
          type: 'Authorization',
          interactionId: briqpaySessionId,
          amount: { centAmount: amount, currencyCode: currency },
          state: 'Success',
        },
      })

      appLogger.info({ updatedPayment, transactionId: transaction?.transactionId }, 'Created Authorization Success')
    } else {
      appLogger.info({ briqpaySessionId }, 'Authorization Success already exists, skipping.')
    }

    // Always attempt to ingest Briqpay session data to order custom fields
    await this.ingestSessionDataToOrder(briqpaySessionId, payment[0].id)
  }

  /**
   * Handles Authorization Rejected status.
   * Maps to CT Transaction Type: Authorization with state: Failure
   */
  private handleAuthorizationRejected = async (payment: Payment[], briqpaySession: MediumBriqpayResponse) => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    if (!payment.length) {
      appLogger.info({ briqpaySessionId }, 'No payment found for rejected authorization, skipping.')
      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Authorization',
        interactionId: briqpaySessionId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Failure',
      },
    })

    appLogger.info({ updatedPayment, transactionId: transaction?.transactionId }, 'Created Authorization Failure')

    // Always attempt to ingest Briqpay session data to order custom fields
    // This is done regardless of whether the authorization was updated, as the order
    // may have been created after the initial authorization
    await this.ingestSessionDataToOrder(briqpaySessionId, payment[0].id)
  }

  /**
   * Handles Capture Pending status.
   * Maps to CT Transaction Type: Charge with state: Pending
   */
  private handleCapturePending = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const capture = getCapture(briqpaySession, briqpayCaptureId)

    // If no payment exists, log and return gracefully
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayCaptureId },
        'No payment found for capture pending, skipping (payment may not be created yet)',
      )
      return
    }

    const alreadyCharged = payment[0].transactions.some(
      (tx) =>
        tx.type === 'Charge' && tx.interactionId === briqpayCaptureId && ['Success', 'Pending'].includes(tx.state),
    )

    if (alreadyCharged) {
      appLogger.info({ briqpaySessionId, briqpayCaptureId }, 'Charge transaction already exists, skipping update.')
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Use capture amount if available, fallback to order amount
    const amount = capture?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = capture?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Pending',
      },
    })

    appLogger.info({ updatedPayment, briqpayCaptureId, captureAmount: amount }, 'Created Charge Pending')
  }

  /**
   * Handles Capture Approved status.
   * Maps to CT Transaction Type: Charge with state: Success
   */
  private handleCaptureApproved = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const capture = getCapture(briqpaySession, briqpayCaptureId)

    appLogger.info({ briqpaySessionId, briqpayCaptureId, paymentId: payment[0]?.id }, 'handleCaptureApproved called')

    // If no payment exists, log and return gracefully
    // This can happen when webhooks arrive before the payment is created in CT
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayCaptureId },
        'No payment found for capture approved, skipping (payment may not be created yet)',
      )
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Use capture amount if available, fallback to order amount
    const amount = capture?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = capture?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Success',
      },
    })

    appLogger.info({ updatedPayment, briqpayCaptureId, captureAmount: amount }, 'Created Charge Success')

    // Ingest Briqpay session data to order custom fields
    await this.ingestSessionDataToOrder(briqpaySessionId, payment[0].id)
  }

  /**
   * Handles Capture Rejected status.
   * Maps to CT Transaction Type: Charge with state: Failure
   */
  private handleCaptureRejected = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayCaptureId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const capture = getCapture(briqpaySession, briqpayCaptureId)

    // If no payment exists, log and return gracefully
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayCaptureId },
        'No payment found for capture rejected, skipping (payment may not be created yet)',
      )
      return
    }

    // Use capture amount if available, fallback to order amount
    const amount = capture?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = capture?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Charge',
        interactionId: briqpayCaptureId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Failure',
      },
    })

    appLogger.info({ updatedPayment, briqpayCaptureId, captureAmount: amount }, 'Created Charge Failure')
  }

  /**
   * Handles Refund Pending status.
   * Maps to CT Transaction Type: Refund with state: Pending
   */
  private handleRefundPending = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const refund = getRefund(briqpaySession, briqpayRefundId)

    // If no payment exists, log and return gracefully
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayRefundId },
        'No payment found for refund pending, skipping (payment may not be created yet)',
      )
      return
    }

    const alreadyRefunded = payment[0].transactions.some(
      (tx) => tx.type === 'Refund' && tx.interactionId === briqpayRefundId && ['Success', 'Pending'].includes(tx.state),
    )

    if (alreadyRefunded) {
      appLogger.info({ briqpaySessionId, briqpayRefundId }, 'Refund transaction already exists, skipping update.')
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Use refund amount if available, fallback to order amount
    const amount = refund?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = refund?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Pending',
      },
    })

    appLogger.info({ updatedPayment, briqpayRefundId, refundAmount: amount }, 'Created Refund Pending')
  }

  /**
   * Handles Refund Approved status.
   * Maps to CT Transaction Type: Refund with state: Success
   */
  private handleRefundApproved = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const refund = getRefund(briqpaySession, briqpayRefundId)

    // If no payment exists, log and return gracefully
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayRefundId },
        'No payment found for refund approved, skipping (payment may not be created yet)',
      )
      return
    }

    // Update pending authorization to success
    await this.updatePendingAuthorization(payment, briqpaySessionId)

    // Use refund amount if available, fallback to order amount
    const amount = refund?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = refund?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Success',
      },
    })

    appLogger.info({ updatedPayment, briqpayRefundId, refundAmount: amount }, 'Created Refund Success')
  }

  /**
   * Handles Refund Rejected status.
   * Maps to CT Transaction Type: Refund with state: Failure
   */
  private handleRefundRejected = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    briqpayRefundId: string,
    _status: BRIQPAY_WEBHOOK_STATUS,
  ) => {
    const briqpaySessionId = briqpaySession.sessionId
    const refund = getRefund(briqpaySession, briqpayRefundId)

    // If no payment exists, log and return gracefully
    if (!payment.length) {
      appLogger.info(
        { briqpaySessionId, briqpayRefundId },
        'No payment found for refund rejected, skipping (payment may not be created yet)',
      )
      return
    }

    // Use refund amount if available, fallback to order amount
    const amount = refund?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = refund?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payment[0].id,
      transaction: {
        type: 'Refund',
        interactionId: briqpayRefundId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Failure',
      },
    })

    appLogger.info({ updatedPayment, briqpayRefundId, refundAmount: amount }, 'Created Refund Failure')
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
