import { CommercetoolsPaymentService, Payment } from '@commercetools/connect-payments-sdk'
import {
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  NotificationRequestSchemaDTO,
} from '../../dtos/briqpay-payment.dto'
import { MediumBriqpayResponse, ORDER_STATUS, TRANSACTION_STATUS } from '../types/briqpay-payment.type'
import { appLogger } from '../../payment-sdk'
import {
  buildPaymentMethodInfoFromSession,
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
import { BriqpaySessionDataService } from './session-data.service'
import { logAmountMismatch, readBriqpaySessionAmounts } from '../../libs/briqpay/session-amounts'
import { apiRoot } from '../../libs/commercetools/api-root'
import { Order } from '@commercetools/platform-sdk'
import {
  getWebhookSecret,
  isHmacVerificationEnabled,
  verifyBriqpayWebhook,
} from '../../libs/briqpay/webhook-verification'
import type { BriqpayOperationService } from './operation.service'

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
   * This service requires HMAC verification (BRIQPAY_WEBHOOK_SECRET must be configured).
   * It trusts the verified webhook payload directly for status updates, transaction data, and
   * custom-field data: every verified webhook that carries transaction data triggers a
   * best-effort background ingestion that writes the session data to the order (or stages it
   * on the cart pre-order) without delaying the webhook response.
   */
  public async processNotification(opts: {
    data: NotificationRequestSchemaDTO
    signatureHeader?: string
    rawBody?: string
  }): Promise<void> {
    const { sessionId: briqpaySessionId } = opts.data
    appLogger.info({ briqpaySessionId, hmacEnabled: isHmacVerificationEnabled() }, 'Processing notification')

    try {
      // HMAC verification is now REQUIRED
      if (!isHmacVerificationEnabled()) {
        appLogger.error({ briqpaySessionId }, 'BRIQPAY_WEBHOOK_SECRET is not configured. Webhooks are disabled.')
        throw new Error('Webhooks disabled: BRIQPAY_WEBHOOK_SECRET missing')
      }

      if (!opts.signatureHeader || !opts.rawBody) {
        appLogger.error({ briqpaySessionId }, 'Missing required signature header or raw body for HMAC verification')
        throw new Error('Webhook verification failed: Missing required signature data')
      }

      await this.processWithHmacVerification(opts)
    } catch (e) {
      this.handleNotificationError(e, opts.data)
    }
  }

  /**
   * Processes webhook with HMAC signature verification.
   * When verified, trusts the webhook payload status and reuses existing handlers.
   */
  private async processWithHmacVerification(opts: {
    data: NotificationRequestSchemaDTO
    signatureHeader?: string
    rawBody?: string
  }): Promise<void> {
    const { data, signatureHeader, rawBody } = opts
    const {
      sessionId: briqpaySessionId,
      event,
      status,
      captureId: captureIdFromPayload,
      refundId: refundIdFromPayload,
      cartId,
    } = data

    const briqpayCaptureId = captureIdFromPayload ?? data.capture?.captureId
    const briqpayRefundId = refundIdFromPayload ?? data.refund?.refundId

    const secret = getWebhookSecret()
    // Secret presence is already checked in processNotification, but TypeScript needs this
    if (!secret || !signatureHeader || !rawBody) {
      throw new Error('Missing required data for HMAC verification')
    }

    // Verify the webhook signature
    const verificationResult = verifyBriqpayWebhook(rawBody, signatureHeader, secret)
    if (!verificationResult.isValid) {
      appLogger.error(
        { briqpaySessionId, error: verificationResult.error },
        'Webhook HMAC verification failed - rejecting webhook',
      )
      throw new Error(`Webhook verification failed: ${verificationResult.error}`)
    }

    appLogger.info(
      { briqpaySessionId, event, status },
      'Webhook HMAC verified - processing with trusted payload for status routing',
    )

    // Session/order webhooks that do not signal a live order (rejections, cancellations,
    // unknown future statuses) must never stage session data onto the cart: the cart will
    // likely never become an order and staging would persist payer PII on it. Allowlist the
    // known-live statuses so unrecognized ones default to no staging; an already-existing
    // order is still enriched via the payment path. Capture/refund events keep the cartId -
    // their session has an approved order by definition.
    const liveOrderStatuses = [
      BRIQPAY_WEBHOOK_STATUS.PENDING,
      BRIQPAY_WEBHOOK_STATUS.APPROVED,
      BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
    ]
    const sessionScopedEvent =
      event === BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS || event === BRIQPAY_WEBHOOK_EVENT.SESSION_STATUS
    const stagingCartId = sessionScopedEvent && !liveOrderStatuses.includes(status) ? undefined : cartId

    // session_status has no routing handler and carries no transaction data, so the payload yields
    // nothing to ingest (order_status carries pspMetadata and drives ingestion). Return before the
    // gate below so Briqpay is not made to retry a webhook that can never do more.
    if (event === BRIQPAY_WEBHOOK_EVENT.SESSION_STATUS) {
      return
    }

    let payment: Payment[] = []
    let briqpaySession: MediumBriqpayResponse | undefined

    try {
      // 1. Mandatory transaction data from payload
      const transactionData = this.extractTransactionDataFromPayload(
        data,
        event,
        briqpayCaptureId,
        briqpayRefundId,
        status,
      )

      if (!transactionData) {
        appLogger.error({ briqpaySessionId, event, data }, 'Webhook payload missing mandatory transaction data')
        throw new Error('Webhook processing failed: Missing transaction data in payload')
      }

      briqpaySession = this.constructSessionFromPayload(
        briqpaySessionId,
        transactionData,
        event,
        briqpayCaptureId,
        briqpayRefundId,
        data.autoCaptured,
        data.pspMetadata,
      )

      // Convert trusted webhook status to the format expected by existing handlers
      const trustedStatuses = this.buildTrustedStatuses(status, event, briqpayCaptureId, briqpayRefundId)

      // Find the payment
      payment = await this.ctPaymentService.findPaymentsByInterfaceId({
        interfaceId: briqpaySessionId,
      })

      // Reuse existing routing logic with trusted statuses. Capture the payment the handler
      // acted on - for the buyer-never-returns flow this is the tagged payment it just
      // created, so ingestion below targets it by concrete id instead of a lagging re-query.
      payment = await this.routeEventToHandler(
        event,
        payment,
        briqpaySession,
        trustedStatuses,
        briqpayCaptureId,
        briqpayRefundId,
        cartId,
      )

      this.logWebhookAmountMismatch(event, payment[0], briqpaySession)
    } finally {
      // Every verified webhook with a payload-built session is an ingestion opportunity: (re)write
      // whatever custom-field data the payload carries, so a field an earlier webhook missed
      // (pre-order race) is written by the next one. Fire-and-forget in a finally: the response is
      // never delayed, payloads that fail routing still ingest, and ingestOnWebhook never rejects.
      if (briqpaySession) {
        void this.ingestOnWebhook(briqpaySession, payment, stagingCartId)
      }
    }
  }

  /**
   * Mismatch check for order-status events only: their payload carries the order amount, which
   * must equal what CT planned. Capture/refund payloads carry the capture/refund amount, so
   * comparing those against amountPlanned would flag every partial capture or refund
   * (e.g. initiated from the Briqpay portal) as a mismatch. Log-only, never throws.
   */
  private logWebhookAmountMismatch(
    event: BRIQPAY_WEBHOOK_EVENT,
    payment: Payment | undefined,
    briqpaySession: MediumBriqpayResponse,
  ): void {
    const planned = payment?.amountPlanned
    if (event !== BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS || !planned) {
      return
    }

    const sessionAmounts = readBriqpaySessionAmounts(briqpaySession)
    if (sessionAmounts.amountIncVat !== planned.centAmount || sessionAmounts.currency !== planned.currencyCode) {
      logAmountMismatch({
        context: `webhook:${event}`,
        sessionId: briqpaySession.sessionId,
        expected: { centAmount: planned.centAmount, currency: planned.currencyCode },
        actual: sessionAmounts,
      })
    }
  }

  /**
   * Unconditional best-effort ingestion, run in the background for EVERY verified webhook.
   * Requires a payment for the session (the selector then stages the cart when the order
   * does not exist yet); payment-less sessions are skipped, matching the pre-existing
   * behavior of never writing session data where no conversion path exists. Never throws.
   *
   * knownPayments is the payment the router resolved - including one a handler just created
   * for the buyer-never-returns flow. Only re-query when it is empty (e.g. session_status,
   * which never routes) so the just-created payment is targeted by concrete id rather than a
   * predicate query that may not have caught up yet.
   */
  private ingestOnWebhook = async (
    session: MediumBriqpayResponse,
    knownPayments: Payment[],
    cartId?: string,
  ): Promise<void> => {
    const briqpaySessionId = session.sessionId
    try {
      const payments = knownPayments.length
        ? knownPayments
        : await this.ctPaymentService.findPaymentsByInterfaceId({
            interfaceId: briqpaySessionId,
          })

      if (payments.length) {
        await this.ingestSessionDataToOrder(session, payments[0].id, cartId)

        return
      }

      appLogger.info({ briqpaySessionId }, 'No payment for session, skipping webhook session data ingestion')
    } catch (error) {
      appLogger.error(
        {
          briqpaySessionId,
          cartId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to ingest Briqpay session data on webhook (non-fatal)',
      )
    }
  }

  private extractTransactionDataFromPayload(
    data: NotificationRequestSchemaDTO,
    event: BRIQPAY_WEBHOOK_EVENT,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
    webhookStatus?: BRIQPAY_WEBHOOK_STATUS,
  ): NotificationRequestSchemaDTO['transaction'] | undefined {
    if (data.transaction) {
      return data.transaction
    }

    if (event === BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS) {
      if (data.capture?.transaction) {
        return data.capture.transaction
      }

      return this.mapTransactionFromCapture(data.capture, briqpayCaptureId, webhookStatus)
    }

    if (event === BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS) {
      if (data.refund?.transaction) {
        return data.refund.transaction
      }

      return this.mapTransactionFromRefund(data.refund, briqpayRefundId, webhookStatus)
    }

    return undefined
  }

  private getValidatedTransactionFields(fields: {
    amountIncVat?: number
    currency?: string
    status?: string
    transactionId?: string
  }): { amountIncVat: number; currency: string; status: string; transactionId: string } | undefined {
    const { amountIncVat, currency, status, transactionId } = fields

    if (typeof amountIncVat !== 'number') {
      return undefined
    }

    if (!currency || typeof currency !== 'string') {
      return undefined
    }

    if (!status || typeof status !== 'string') {
      return undefined
    }

    if (!transactionId || typeof transactionId !== 'string') {
      return undefined
    }

    return {
      amountIncVat,
      currency,
      status,
      transactionId,
    }
  }

  private mapTransactionFromCapture(
    capture: NotificationRequestSchemaDTO['capture'],
    briqpayCaptureId?: string,
    webhookStatus?: BRIQPAY_WEBHOOK_STATUS,
  ): NotificationRequestSchemaDTO['transaction'] | undefined {
    if (!capture) {
      return undefined
    }

    const transactionId = capture.transactionId ?? capture.parentTransactionId ?? capture.captureId ?? briqpayCaptureId
    const status = capture.status ?? webhookStatus
    const essentials = this.getValidatedTransactionFields({
      amountIncVat: capture.amountIncVat,
      currency: capture.currency,
      status,
      transactionId,
    })

    if (!essentials) {
      return undefined
    }

    return {
      ...essentials,
      amountExVat: capture.amountExVat,
      createdAt: capture.createdAt,
      reservationId: capture.reservationId,
      pspId: capture.pspId,
      pspDisplayName: capture.pspDisplayName,
      pspIntegrationName: capture.pspIntegrationName,
      email: capture.email,
      phoneNumber: capture.phoneNumber,
    }
  }

  private mapTransactionFromRefund(
    refund: NotificationRequestSchemaDTO['refund'],
    briqpayRefundId?: string,
    webhookStatus?: BRIQPAY_WEBHOOK_STATUS,
  ): NotificationRequestSchemaDTO['transaction'] | undefined {
    if (!refund) {
      return undefined
    }

    const transactionId =
      refund.transactionId ?? refund.parentTransactionId ?? refund.parentCaptureId ?? refund.refundId ?? briqpayRefundId
    const status = refund.status ?? webhookStatus
    const essentials = this.getValidatedTransactionFields({
      amountIncVat: refund.amountIncVat,
      currency: refund.currency,
      status,
      transactionId,
    })

    if (!essentials) {
      return undefined
    }

    return {
      ...essentials,
      amountExVat: refund.amountExVat,
      createdAt: refund.createdAt,
      reservationId: refund.reservationId,
      pspId: refund.pspId,
      pspDisplayName: refund.pspDisplayName,
      pspIntegrationName: refund.pspIntegrationName,
      email: refund.email,
      phoneNumber: refund.phoneNumber,
    }
  }

  /**
   * Constructs a partial Briqpay session object from the webhook payload.
   */
  private constructSessionFromPayload(
    briqpaySessionId: string,
    transactionData: NonNullable<NotificationRequestSchemaDTO['transaction']>,
    event: BRIQPAY_WEBHOOK_EVENT,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
    autoCaptured?: boolean,
    pspMetadata?: NotificationRequestSchemaDTO['pspMetadata'],
  ): MediumBriqpayResponse {
    const briqpaySession: MediumBriqpayResponse = {
      sessionId: briqpaySessionId,
      htmlSnippet: '', // Not needed for notifications
      data: {
        ...(pspMetadata && { pspMetadata }),
        order: {
          amountIncVat: transactionData.amountIncVat,
          amountExVat: transactionData.amountExVat,
          currency: transactionData.currency,
          cart: [],
        },
        transactions: [
          {
            transactionId: transactionData.transactionId,
            status: transactionData.status as TRANSACTION_STATUS,
            amountIncVat: transactionData.amountIncVat,
            amountExVat: transactionData.amountExVat,
            currency: transactionData.currency,
            createdAt: transactionData.createdAt,
            reservationId: transactionData.reservationId,
            secondaryReservationId: transactionData.secondaryReservationId,
            pspId: transactionData.pspId,
            pspDisplayName: transactionData.pspDisplayName,
            pspIntegrationName: transactionData.pspIntegrationName,
            email: transactionData.email,
            phoneNumber: transactionData.phoneNumber,
          },
        ],
      },
    }

    // Provide capture/refund arrays expected by existing handlers when those events are received.
    // This allows downstream logic to use the webhook payload as source of truth without fetching the session.
    if (event === BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS && briqpayCaptureId) {
      briqpaySession.data = {
        ...briqpaySession.data,
        captures: [
          {
            captureId: briqpayCaptureId,
            status: transactionData.status as TRANSACTION_STATUS,
            amountIncVat: transactionData.amountIncVat,
            amountExVat: transactionData.amountExVat,
            currency: transactionData.currency,
            createdAt: transactionData.createdAt,
            reservationId: transactionData.reservationId,
            autoCaptured,
            pspId: transactionData.pspId,
            pspDisplayName: transactionData.pspDisplayName,
            pspIntegrationName: transactionData.pspIntegrationName,
            email: transactionData.email,
            phoneNumber: transactionData.phoneNumber,
            cart: [],
          },
        ],
      }
    }

    if (event === BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS && briqpayRefundId) {
      briqpaySession.data = {
        ...briqpaySession.data,
        refunds: [
          {
            refundId: briqpayRefundId,
            status: transactionData.status as TRANSACTION_STATUS,
            amountIncVat: transactionData.amountIncVat,
            amountExVat: transactionData.amountExVat,
            currency: transactionData.currency,
            createdAt: transactionData.createdAt,
            reservationId: transactionData.reservationId,
            pspId: transactionData.pspId,
            pspDisplayName: transactionData.pspDisplayName,
            pspIntegrationName: transactionData.pspIntegrationName,
            cart: [],
          },
        ],
      }
    }

    return briqpaySession
  }

  /**
   * Extracts actual statuses from the Briqpay session response.
   * This is a helper for the routing logic that still expects this structure.
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
   * Builds status object from trusted webhook payload for use with existing handlers.
   * Maps BRIQPAY_WEBHOOK_STATUS to the internal ORDER_STATUS/TRANSACTION_STATUS enums.
   */
  private buildTrustedStatuses(
    webhookStatus: BRIQPAY_WEBHOOK_STATUS,
    event: BRIQPAY_WEBHOOK_EVENT,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
  ): ReturnType<typeof this.extractActualStatuses> {
    // Map webhook status to ORDER_STATUS enum
    const orderStatusMap: Partial<Record<BRIQPAY_WEBHOOK_STATUS, ORDER_STATUS>> = {
      [BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING]: ORDER_STATUS.ORDER_PENDING,
      [BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED]: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      [BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED]: ORDER_STATUS.ORDER_REJECTED,
      [BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED]: ORDER_STATUS.ORDER_CANCELLED,
    }

    // Map webhook status to TRANSACTION_STATUS enum
    const transactionStatusMap: Partial<Record<BRIQPAY_WEBHOOK_STATUS, TRANSACTION_STATUS>> = {
      [BRIQPAY_WEBHOOK_STATUS.PENDING]: TRANSACTION_STATUS.PENDING,
      [BRIQPAY_WEBHOOK_STATUS.APPROVED]: TRANSACTION_STATUS.APPROVED,
      [BRIQPAY_WEBHOOK_STATUS.REJECTED]: TRANSACTION_STATUS.REJECTED,
    }

    const orderStatus = orderStatusMap[webhookStatus]
    const transactionStatus = transactionStatusMap[webhookStatus]

    return {
      orderStatus: event === BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS ? orderStatus : undefined,
      authorizationStatus: event === BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS ? transactionStatus : undefined,
      captureStatus: event === BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS && briqpayCaptureId ? transactionStatus : undefined,
      refundStatus: event === BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS && briqpayRefundId ? transactionStatus : undefined,
    }
  }

  /**
   * Routes the webhook event to the appropriate handler based on event type. Returns the
   * payment(s) the handler acted on - for the ORDER_STATUS buyer-never-returns flow this is
   * the tagged payment the handler just created, so the caller's background ingestion targets
   * it by concrete id instead of re-querying. Capture/refund never create payments, so they
   * pass the input payment through unchanged.
   */
  private async routeEventToHandler(
    event: BRIQPAY_WEBHOOK_EVENT,
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualStatuses: ReturnType<typeof this.extractActualStatuses>,
    briqpayCaptureId?: string,
    briqpayRefundId?: string,
    cartId?: string,
  ): Promise<Payment[]> {
    switch (event) {
      case BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS:
        return this.processOrderStatusEvent(payment, briqpaySession, actualStatuses, cartId)
      case BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS:
        await this.processCaptureStatusEvent(payment, briqpaySession, actualStatuses.captureStatus, briqpayCaptureId)

        return payment
      case BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS:
        await this.processRefundStatusEvent(payment, briqpaySession, actualStatuses.refundStatus, briqpayRefundId)

        return payment
      default:
        return payment
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
    cartId?: string,
  ): Promise<Payment[]> {
    const { orderStatus, authorizationStatus } = actualStatuses

    // Prefer authorization status from transactions array if available
    // This gives us pending/approved directly from the transaction
    if (authorizationStatus) {
      const authWebhookStatus = transactionStatusToWebhookStatus(authorizationStatus)
      appLogger.info(
        { authorizationStatus, authWebhookStatus },
        'Processing authorization status from data.transactions',
      )

      const authHandlers: Partial<Record<BRIQPAY_WEBHOOK_STATUS, () => Promise<Payment[]>>> = {
        [BRIQPAY_WEBHOOK_STATUS.PENDING]: () =>
          this.dispatchAuthorization(this.handleAuthorizationPending, payment, briqpaySession, cartId),
        [BRIQPAY_WEBHOOK_STATUS.APPROVED]: () =>
          this.dispatchAuthorization(this.handleAuthorizationApproved, payment, briqpaySession, cartId),
        [BRIQPAY_WEBHOOK_STATUS.REJECTED]: () =>
          this.dispatchAuthorization(this.handleAuthorizationRejected, payment, briqpaySession, cartId),
      }

      const handler = authHandlers[authWebhookStatus]
      if (handler) {
        return handler()
      }
    }

    // Fallback to moduleStatus.payment.orderStatus if no transactions
    if (!orderStatus) {
      appLogger.warn(
        { briqpaySessionId: briqpaySession.sessionId },
        'No authorization status in transactions and no orderStatus in moduleStatus, skipping',
      )

      return payment
    }

    const orderWebhookStatus = orderStatusToWebhookStatus(orderStatus)
    appLogger.info({ orderStatus, orderWebhookStatus }, 'Processing order status from moduleStatus (fallback)')

    const orderHandlers: Partial<Record<BRIQPAY_WEBHOOK_STATUS, () => Promise<Payment[]>>> = {
      [BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING]: () =>
        this.dispatchAuthorization(this.handleAuthorizationPending, payment, briqpaySession, cartId),
      [BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED]: () =>
        this.dispatchAuthorization(this.handleAuthorizationApproved, payment, briqpaySession, cartId),
      [BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED]: () =>
        this.dispatchAuthorization(this.handleAuthorizationRejected, payment, briqpaySession, cartId),
      [BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED]: () =>
        this.dispatchAuthorization(this.handleAuthorizationCancelled, payment, briqpaySession, cartId),
    }

    const handler = orderHandlers[orderWebhookStatus]
    if (handler) {
      return handler()
    }

    appLogger.warn(
      { briqpaySessionId: briqpaySession.sessionId, orderWebhookStatus },
      'Unhandled order status - CT left untouched',
    )

    return payment
  }

  /**
   * Processes CAPTURE_STATUS webhook events using actual status from session.
   */
  private async processCaptureStatusEvent(
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    actualCaptureStatus: TRANSACTION_STATUS | undefined,
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
    actualRefundStatus: TRANSACTION_STATUS | undefined,
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
   * Handles notification errors by logging and potentially taking corrective action.
   */
  private handleNotificationError(e: unknown, data: NotificationRequestSchemaDTO): void {
    const error = e instanceof Error ? e : new Error(String(e))
    appLogger.error(
      { error: error.message, sessionId: data.sessionId, event: data.event },
      'Error processing notification',
    )
    throw error
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
   * Returns the CT Payment(s) to act on for an order-status webhook. When the cart already has a
   * Payment (the common case) it is returned as-is. When it has none - the buyer-never-returns case
   * where /payments never ran - the tagged Payment is created from the checkoutTransactionItemId
   * persisted at config() time (via the shared dedupe path), so the handler can drive Order
   * creation. Returns an empty array when there is no cartId or no persisted tag, so the handler
   * keeps its existing skip (never a tagless Payment).
   */
  private resolvePaymentForWebhook = async (
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    cartId?: string,
  ): Promise<Payment[]> => {
    if (payment.length) {
      return payment
    }

    const briqpaySessionId = briqpaySession.sessionId

    if (!cartId) {
      appLogger.warn(
        { briqpaySessionId },
        'Order-status webhook for a payment-less cart but no cartId on the webhook - cannot create Payment',
      )

      return payment
    }

    const ensured = await this.operationService.ensurePaymentForWebhook(cartId, briqpaySession)

    return ensured ? [ensured] : []
  }

  /**
   * Resolves (and, for a payment-less cart, creates) the tagged payment ONCE, dispatches the
   * matched authorization handler, and returns the resolved payment so the caller can thread
   * it to background ingestion by concrete id. Keeping resolution here lets the handlers stay
   * single-purpose void functions (they only write the CT transaction).
   */
  private dispatchAuthorization = async (
    handler: (payments: Payment[], briqpaySession: MediumBriqpayResponse) => Promise<void>,
    payment: Payment[],
    briqpaySession: MediumBriqpayResponse,
    cartId?: string,
  ): Promise<Payment[]> => {
    const payments = await this.resolvePaymentForWebhook(payment, briqpaySession, cartId)
    await handler(payments, briqpaySession)

    return payments
  }

  /**
   * Handles Authorization Pending status.
   * Maps to CT Transaction Type: Authorization with state: Pending
   */
  private handleAuthorizationPending = async (
    payments: Payment[],
    briqpaySession: MediumBriqpayResponse,
  ): Promise<void> => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    const alreadyExists = payments?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId,
    )

    if (alreadyExists) {
      appLogger.info({ briqpaySessionId }, 'Authorization transaction already exists, skipping update.')

      return
    }

    // No CT Payment and no persisted checkoutTransactionItemId - keep skipping (never create a
    // tagless Payment, which would block automatic Order creation).
    if (!payments.length) {
      appLogger.warn(
        { briqpaySessionId },
        'ORDER_STATUS pending but no CT Payment and no persisted checkoutTransactionItemId - skipping',
      )

      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    // The PSP that processed the payment - written only while method/name are still empty (SDK
    // semantics), so this fills the fields for payments the /payments call could not (e.g. the
    // buyer-never-returns flow) without ever flipping an already-set value.
    const paymentMethodInfo = buildPaymentMethodInfoFromSession(briqpaySession)

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payments[0].id,
      ...(paymentMethodInfo && { paymentMethodInfo }),
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
  private handleAuthorizationApproved = async (
    payments: Payment[],
    briqpaySession: MediumBriqpayResponse,
  ): Promise<void> => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    const alreadySuccessful = payments?.[0]?.transactions.some(
      (tx) => tx.type === 'Authorization' && tx.interactionId === briqpaySessionId && tx.state === 'Success',
    )

    // No CT Payment and no persisted checkoutTransactionItemId - keep skipping (never create a
    // tagless Payment, which would block automatic Order creation).
    if (!payments.length) {
      appLogger.warn(
        { briqpaySessionId },
        'ORDER_STATUS approved but no CT Payment and no persisted checkoutTransactionItemId - skipping',
      )

      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    // The PSP that processed the payment - written only while method/name are still empty (SDK
    // semantics), same as the pending handler.
    const paymentMethodInfo = buildPaymentMethodInfoFromSession(briqpaySession)

    // Update authorization to Success if not already done
    if (!alreadySuccessful) {
      const updatedPayment = await this.ctPaymentService.updatePayment({
        id: payments[0].id,
        ...(paymentMethodInfo && { paymentMethodInfo }),
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
  }

  /**
   * Handles Authorization Rejected status.
   * Maps to CT Transaction Type: Authorization with state: Failure
   */
  private handleAuthorizationRejected = async (
    payments: Payment[],
    briqpaySession: MediumBriqpayResponse,
  ): Promise<void> => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    if (!payments.length) {
      appLogger.info({ briqpaySessionId }, 'No payment found for rejected authorization, skipping.')

      return
    }

    // Use transaction amount if available, fallback to order amount
    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat ?? 0
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency ?? 'EUR'

    // Written on the failed payment too - which PSP rejected is exactly what the merchant
    // needs to see. Still write-when-empty via the SDK.
    const paymentMethodInfo = buildPaymentMethodInfoFromSession(briqpaySession)

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payments[0].id,
      ...(paymentMethodInfo && { paymentMethodInfo }),
      transaction: {
        type: 'Authorization',
        interactionId: briqpaySessionId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Failure',
      },
    })

    appLogger.info({ updatedPayment, transactionId: transaction?.transactionId }, 'Created Authorization Failure')
  }

  /**
   * Handles Authorization Cancelled status.
   * Maps to CT Transaction Type: CancelAuthorization with state: Success
   *
   * A cancel is recorded as a cancellation rather than a failed authorization so that a cancel made
   * from the Briqpay portal looks the same in commercetools as one made through cancelPayment. Briqpay
   * emits order_cancelled for both, so cancelPayment's own record has to be left alone when it echoes
   * back - and the SDK cannot match it, since it carries no interactionId.
   */
  private handleAuthorizationCancelled = async (
    payments: Payment[],
    briqpaySession: MediumBriqpayResponse,
  ): Promise<void> => {
    const briqpaySessionId = briqpaySession.sessionId
    const transaction = getTransaction(briqpaySession)

    if (!payments.length) {
      appLogger.info({ briqpaySessionId }, 'No payment found for cancelled authorization, skipping.')

      return
    }

    const alreadyCancelled = payments[0].transactions.some((tx) => tx.type === 'CancelAuthorization')
    if (alreadyCancelled) {
      appLogger.info({ briqpaySessionId }, 'CancelAuthorization already exists, skipping.')

      return
    }

    const amount = transaction?.amountIncVat ?? briqpaySession.data?.order?.amountIncVat
    const currency = transaction?.currency ?? briqpaySession.data?.order?.currency
    if (!amount || !currency) {
      appLogger.error({ briqpaySessionId }, 'Cancelled notification carries no amount, skipping.')

      return
    }

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: payments[0].id,
      transaction: {
        type: 'CancelAuthorization',
        interactionId: briqpaySessionId,
        amount: { centAmount: amount, currencyCode: currency },
        state: 'Success',
      },
    })

    appLogger.info({ updatedPayment, transactionId: transaction?.transactionId }, 'Created CancelAuthorization')
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
   * @param session - The Briqpay session built from the verified webhook payload
   * @param paymentId - The CommerceTools payment ID
   * @param cartId - The cart to stage data on when the order does not exist yet
   */
  private ingestSessionDataToOrder = async (
    session: MediumBriqpayResponse,
    paymentId: string,
    cartId?: string,
  ): Promise<void> => {
    const briqpaySessionId = session.sessionId
    appLogger.info({ briqpaySessionId, paymentId, cartId }, 'Starting ingestSessionDataToOrder lookup')

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
        // Pre-order webhook race: the order has not been auto-created yet. Stage the data on the
        // cart so CT copies it onto the order at creation. When no cartId is in scope (e.g. the
        // capture path) keep the prior behavior of skipping.
        if (!cartId) {
          appLogger.info(
            { paymentId, briqpaySessionId },
            'No order and no cartId, skipping session data ingestion (order may not be created yet)',
          )

          return
        }

        appLogger.info(
          { paymentId, briqpaySessionId, cartId },
          'No order yet - staging Briqpay session data on cart for copy-on-creation',
        )
        await this.sessionDataService.ingestSessionDataToCart(session, cartId)

        return
      }

      const order = orders[0]
      appLogger.info(
        { orderId: order.id, paymentId, briqpaySessionId, orderVersion: order.version, hasCustom: !!order.custom },
        'Found order for payment, starting session data ingestion',
      )

      // Ingest the session data to the order
      await this.sessionDataService.ingestSessionDataToOrder(session, order.id)
    } catch (error) {
      // Log the error but don't fail the notification processing
      // The session data ingestion is a best-effort operation
      appLogger.error(
        {
          briqpaySessionId,
          paymentId,
          cartId,
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to ingest Briqpay session data (non-fatal)',
      )
    }
  }
}
