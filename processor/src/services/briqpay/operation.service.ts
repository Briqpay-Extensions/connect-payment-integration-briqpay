import {
  Cart,
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  ErrorInvalidOperation,
  Money,
  Payment,
  TransactionState,
  TransactionType,
} from '@commercetools/connect-payments-sdk'
import type { Cart as PlatformCart } from '@commercetools/platform-sdk'
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  PaymentProviderModificationResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
} from '../types/operation.type'
import { CreatePaymentRequest } from '../types/briqpay-payment.type'
import { PaymentOutcome, PaymentResponseSchemaDTO } from '../../dtos/briqpay-payment.dto'
import { TransactionDraftDTO, TransactionResponseDTO } from '../../dtos/operations/transaction.dto'
import {
  getCartIdFromContext,
  getCheckoutTransactionItemIdFromContext,
  getFutureOrderNumberFromContext,
  getPaymentInterfaceFromContext,
} from '../../libs/fastify/context/context'
import { appLogger } from '../../payment-sdk'
import Briqpay from '../../libs/briqpay/BriqpayService'
import {
  convertNotificationStatus,
  convertPaymentModificationStatusCode,
  convertPaymentResultCode,
  getActualOrderStatus,
  orderStatusToWebhookStatus,
} from './utils'
import { SessionError, ValidationError } from '../../libs/errors/briqpay-errors'
import { briqpaySessionIdFieldName } from '../../custom-types/custom-types'
import { apiRoot } from '../../libs/commercetools/api-root'

const PAYMENT_KEY_PREFIX = 'briqpay-'

const buildPaymentKey = (briqpaySessionId: string): string => `${PAYMENT_KEY_PREFIX}${briqpaySessionId}`

type CtErrorShape = {
  httpErrorStatus?: number
  statusCode?: number
  code?: string
  fields?: Array<{ code?: string; field?: string }>
}

// CT errors reach this file via two paths: ctPaymentService (wrapped in CommercetoolsAPIError,
// which exposes httpErrorStatus) and apiRoot/platform-sdk (raw, exposes statusCode). Both
// predicates accept either property so the predicate can't be silently broken by the next
// SDK upgrade or by adding a new caller that uses a different client.
const isDuplicateKeyError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const e = err as CtErrorShape
  if (e.httpErrorStatus !== 400 && e.statusCode !== 400) return false
  if (e.code !== 'DuplicateField') return false
  return Array.isArray(e.fields) && e.fields.some((f) => f?.code === 'DuplicateField' && f?.field === 'key')
}

const isNotFoundError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const e = err as CtErrorShape
  return e.httpErrorStatus === 404 || e.statusCode === 404
}

export class BriqpayOperationService {
  constructor(
    private readonly ctCartService: CommercetoolsCartService,
    private readonly ctPaymentService: CommercetoolsPaymentService,
  ) {}

  public async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    if (!briqpaySessionId) {
      throw new SessionError('Cannot find briqpay session for capture')
    }

    const captureExists = request.payment.transactions.some((tx) => tx.type === 'Charge' && tx.state !== 'Failure')
    if (captureExists) {
      throw new ErrorInvalidOperation('Payment is already captured')
    }

    const ctCart = await this.ctCartService.getCartByPaymentId({
      paymentId: request.payment.id,
    })

    if (request.amount?.centAmount !== (ctCart.taxedPrice?.totalGross?.centAmount ?? ctCart.totalPrice.centAmount)) {
      throw new ValidationError('Commerce Tools does not support partial captures towards all payment providers')
    }

    const briqpayCapture = await Briqpay.capture(
      ctCart as PlatformCart,
      request.payment.amountPlanned,
      briqpaySessionId,
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
          state: convertPaymentResultCode(PaymentOutcome.APPROVED),
        },
      })
    }

    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Charge',
        amount: request.amount,
        state: convertPaymentResultCode(briqpayCapture.status),
        interactionId: briqpayCapture.captureId,
      },
    })

    return {
      outcome: convertPaymentModificationStatusCode(briqpayCapture.status),
      pspReference: request.payment.interfaceId as string,
    }
  }

  public async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    if (!briqpaySessionId) {
      throw new SessionError('Cannot find briqpay session for cancellation')
    }

    // Check if there's already a successful capture
    const hasCapture = request.payment.transactions.some((tx) => tx.type === 'Charge' && tx.state === 'Success')
    if (hasCapture) {
      throw new ErrorInvalidOperation('Cannot cancel a payment that has been captured')
    }

    try {
      const cancelResult = await Briqpay.cancel(briqpaySessionId)

      await this.ctPaymentService.updatePayment({
        id: request.payment.id,
        transaction: {
          type: 'CancelAuthorization',
          amount: request.payment.amountPlanned,
          state: convertPaymentResultCode(cancelResult.status),
        },
      })

      return {
        outcome: convertPaymentModificationStatusCode(cancelResult.status),
        pspReference: request.payment.interfaceId as string,
      }
    } catch (error) {
      appLogger.error({ error }, 'Failed to cancel Briqpay payment:')
      throw error
    }
  }

  public async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    appLogger.info({ paymentId: request.payment.id }, 'Starting refundPayment')

    const briqpaySessionId = request.payment.transactions.find((tx) => tx.type === 'Authorization')?.interactionId
    appLogger.info({ briqpaySessionId, transactions: request.payment.transactions }, 'Found briqpay session ID')

    if (!briqpaySessionId) {
      appLogger.error({ transactions: request.payment.transactions }, 'Cannot find briqpay session')
      throw new ErrorInvalidOperation('Cannot find briqpay session')
    }

    const existingCapture = request.payment.transactions.find((tx) => tx.type === 'Charge' && tx.state === 'Success')
    appLogger.info({ existingCapture }, 'Found existing capture')

    if (!existingCapture) {
      appLogger.error({ transactions: request.payment.transactions }, 'Must have a successful capture first')
      throw new ErrorInvalidOperation('Must have a successful capture first')
    }

    const refundExists = request.payment.transactions.some((tx) => tx.type === 'Refund' && tx.state !== 'Failure')
    appLogger.info({ refundExists }, 'Checking if refund already exists')

    if (refundExists) {
      appLogger.error({ transactions: request.payment.transactions }, 'Already refunded')
      throw new ErrorInvalidOperation('Already refunded')
    }

    appLogger.info({ paymentId: request.payment.id }, 'Getting cart by payment ID')
    const ctCart = await this.ctCartService.getCartByPaymentId({
      paymentId: request.payment.id,
    })
    appLogger.info({ cartId: ctCart.id }, 'Retrieved cart')

    const expectedAmount = ctCart.taxedPrice?.totalGross?.centAmount ?? ctCart.totalPrice.centAmount
    appLogger.info({ requestedAmount: request.amount?.centAmount, expectedAmount }, 'Checking refund amount')

    if (request.amount?.centAmount !== expectedAmount) {
      appLogger.error({ requestedAmount: request.amount?.centAmount, expectedAmount }, 'Amount mismatch')
      throw new ErrorInvalidOperation('Commerce Tools does not support partial refunds towards all payment providers')
    }

    appLogger.info(
      { sessionId: briqpaySessionId, captureId: existingCapture.interactionId },
      'Calling Briqpay refund API',
    )
    const briqpayRefund = await Briqpay.refund(
      ctCart as PlatformCart,
      request.payment.amountPlanned,
      briqpaySessionId,
      existingCapture.interactionId,
    )
    appLogger.info({ briqpayRefund }, 'Briqpay refund completed')

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
          state: convertPaymentResultCode(PaymentOutcome.APPROVED),
        },
      })
    }

    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Refund',
        amount: request.amount,
        state: convertPaymentResultCode(briqpayRefund.status),
        interactionId: briqpayRefund.refundId,
      },
    })

    return {
      outcome: convertPaymentModificationStatusCode(briqpayRefund.status),
      pspReference: request.payment.interfaceId as string,
    }
  }

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

  public async createPayment(request: CreatePaymentRequest): Promise<PaymentResponseSchemaDTO> {
    const cartId = request.cartId || getCartIdFromContext()
    const ctCart = await this.ctCartService.getCart({
      id: cartId,
    })

    const briqpaySessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName] as string | undefined

    // Dedupe: a CT Cart with multiple Payments blocks Checkout's automatic Order creation.
    // Reuse the existing Payment for this Briqpay session instead of creating a duplicate
    // when the connector is invoked more than once for the same session (retries, double-submit,
    // out-of-order webhooks, browser back-and-forth in Checkout).
    if (briqpaySessionId) {
      const existing = await this.findOrAttachExistingPaymentForSession(ctCart, briqpaySessionId)
      if (existing) {
        const updatedPayment = await this.ctPaymentService.updatePayment({
          id: existing.id,
          pspReference: briqpaySessionId,
          paymentMethod: request.data.paymentMethod.type,
          transaction: {
            type: 'Authorization',
            amount: existing.amountPlanned,
            interactionId: briqpaySessionId,
            state: convertPaymentResultCode(request.data.paymentOutcome),
          },
        })
        await this.detachStaleBriqpayPayments(
          ctCart.id,
          updatedPayment.id,
          existing.paymentMethodInfo?.paymentInterface ?? 'Briqpay',
        )
        return {
          paymentReference: updatedPayment.id,
        }
      }
    }

    // No existing Payment found via the search index. Try to create with a deterministic key
    // (`briqpay-<sessionId>`). CT enforces key uniqueness atomically at the database level —
    // concurrent createPayment calls with the same key result in exactly one success and a
    // DuplicateField error for the rest. We catch that error and recover by fetching the
    // winning Payment by key, ensuring it's attached to the cart, and returning its id.
    // This closes the race window that `findPaymentsByInterfaceId` (search-index based) leaves
    // open during truly concurrent invocations of this endpoint.
    const ctPayment = await this.createOrRecoverPaymentForCheckout(ctCart, briqpaySessionId)

    const pspReference = briqpaySessionId ?? ctCart.custom?.fields?.[briqpaySessionIdFieldName]
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference,
      paymentMethod: request.data.paymentMethod.type,
      transaction: {
        type: 'Authorization',
        amount: ctPayment.amountPlanned,
        interactionId: pspReference,
        state: convertPaymentResultCode(request.data.paymentOutcome),
      },
    })

    await this.detachStaleBriqpayPayments(
      ctCart.id,
      updatedPayment.id,
      ctPayment.paymentMethodInfo?.paymentInterface ?? 'Briqpay',
    )

    return {
      paymentReference: updatedPayment.id,
    }
  }

  public async handleTransaction(transactionDraft: TransactionDraftDTO): Promise<TransactionResponseDTO> {
    const TRANSACTION_AUTHORIZATION_TYPE: TransactionType = 'Authorization'

    const futureOrderNumberFromDto = transactionDraft.futureOrderNumber
    const futureOrderNumberFromContext = getFutureOrderNumberFromContext()

    appLogger.info(
      {
        cartId: transactionDraft.cartId,
        futureOrderNumberFromDto,
        futureOrderNumberFromContext,
        paymentInterface: transactionDraft.paymentInterface,
      },
      'handleTransaction called with futureOrderNumber details',
    )

    const ctCart = await this.ctCartService.getCart({ id: transactionDraft.cartId })

    let amountPlanned = transactionDraft.amount
    if (!amountPlanned) {
      amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart })
    }

    // Retrieve the Briqpay session ID stored on the cart during the checkout flow
    const briqpaySessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName] as string | undefined

    if (!briqpaySessionId) {
      appLogger.error({ cartId: ctCart.id }, 'No Briqpay session ID found on cart')
      return {
        transactionStatus: {
          errors: [{ code: 'PaymentRejected', message: 'No Briqpay session found for this cart.' }],
          state: 'Failed',
        },
      }
    }

    // Fetch the Briqpay session to determine the actual authorization status
    const briqpaySession = await Briqpay.getSession(briqpaySessionId)
    const orderStatus = getActualOrderStatus(briqpaySession)

    appLogger.info(
      { briqpaySessionId, orderStatus, cartId: ctCart.id },
      'handleTransaction: fetched Briqpay session status',
    )

    // Map Briqpay order status → CT transaction state
    const transactionState: TransactionState = orderStatus
      ? convertNotificationStatus(orderStatusToWebhookStatus(orderStatus))
      : 'Pending'

    // Dedupe: a CT Cart with multiple Payments blocks Checkout's automatic Order creation.
    // Reuse the existing Payment for this Briqpay session instead of creating a duplicate.
    const existingPayment = await this.findOrAttachExistingPaymentForSession(ctCart, briqpaySessionId)

    let paymentForTransaction: Payment
    if (existingPayment) {
      paymentForTransaction = existingPayment
      appLogger.info(
        { paymentId: existingPayment.id, briqpaySessionId, cartId: ctCart.id },
        'handleTransaction: reusing existing CT Payment for Briqpay session',
      )
    } else {
      paymentForTransaction = await this.createOrRecoverPaymentForTransaction(
        ctCart,
        briqpaySessionId,
        amountPlanned,
        transactionDraft.paymentInterface,
      )
    }

    await this.ctPaymentService.updatePayment({
      id: paymentForTransaction.id,
      pspReference: briqpaySessionId,
      transaction: {
        amount: amountPlanned,
        type: TRANSACTION_AUTHORIZATION_TYPE,
        state: transactionState,
        interactionId: briqpaySessionId,
      },
    })

    await this.detachStaleBriqpayPayments(
      ctCart.id,
      paymentForTransaction.id,
      paymentForTransaction.paymentMethodInfo?.paymentInterface ?? 'Briqpay',
    )

    if (transactionState === 'Failure') {
      return {
        transactionStatus: {
          errors: [
            {
              code: 'PaymentRejected',
              message: `Payment '${paymentForTransaction.id}' has been rejected by Briqpay (orderStatus: ${orderStatus}).`,
            },
          ],
          state: 'Failed',
        },
      }
    }

    return {
      transactionStatus: {
        errors: [],
        state: 'Pending',
      },
    }
  }

  /**
   * Returns the CT Payment that already represents this Briqpay session, attaching it to the
   * cart if it exists in CT but isn't linked yet. Returns undefined when no such Payment exists.
   *
   * Used to dedupe Payment creation across retries / double-submits / out-of-order webhooks —
   * a CT Cart with multiple attached Payments blocks Checkout's automatic Order creation.
   */
  private async findOrAttachExistingPaymentForSession(
    cart: Cart,
    briqpaySessionId: string,
  ): Promise<Payment | undefined> {
    if (!briqpaySessionId) {
      return undefined
    }

    const candidates =
      (await this.ctPaymentService.findPaymentsByInterfaceId({
        interfaceId: briqpaySessionId,
      })) ?? []

    if (candidates.length === 0) {
      return undefined
    }

    if (candidates.length > 1) {
      appLogger.warn(
        { briqpaySessionId, paymentIds: candidates.map((p) => p.id), cartId: cart.id },
        'Multiple CT Payments found for the same Briqpay session — using the first',
      )
    }

    const payment = candidates[0]
    const attachedPaymentIds = new Set(cart.paymentInfo?.payments?.map((p) => p.id) ?? [])

    if (attachedPaymentIds.has(payment.id)) {
      return payment
    }

    appLogger.info(
      { paymentId: payment.id, briqpaySessionId, cartId: cart.id },
      'Found existing CT Payment for Briqpay session not yet attached to cart — attaching',
    )
    await this.ctCartService.addPayment({
      resource: { id: cart.id, version: cart.version },
      paymentId: payment.id,
    })

    return payment
  }

  /**
   * Creates a fresh CT Payment for the storefront-initiated checkout and attaches it to
   * the cart, or — if a concurrent caller already won the deterministic key — recovers by
   * fetching the winning Payment by key and attaching it to the cart instead.
   *
   * Used by createPayment when the cheap interfaceId-based dedupe missed.
   *
   * When the cart has no Briqpay session yet, no key is set and only the legacy create-
   * and-attach happens (no race-recovery branch is needed because there's nothing to
   * collide on).
   */
  private async createOrRecoverPaymentForCheckout(
    ctCart: Cart,
    briqpaySessionId: string | undefined,
  ): Promise<Payment> {
    const paymentKey = briqpaySessionId ? buildPaymentKey(briqpaySessionId) : undefined
    try {
      const newPayment = await this.ctPaymentService.createPayment({
        ...(paymentKey && { key: paymentKey }),
        amountPlanned: await this.ctCartService.getPaymentAmount({ cart: ctCart }),
        paymentMethodInfo: {
          paymentInterface: getPaymentInterfaceFromContext() || 'Briqpay',
        },
        checkoutTransactionItemId: getCheckoutTransactionItemIdFromContext(),
        ...(briqpaySessionId && { interfaceId: briqpaySessionId }),
        ...(ctCart.customerId && { customer: { typeId: 'customer', id: ctCart.customerId } }),
        ...(!ctCart.customerId &&
          ctCart.anonymousId && {
            anonymousId: ctCart.anonymousId,
          }),
      })

      const freshCart = await this.ctCartService.getCart({ id: ctCart.id })
      await this.ctCartService.addPayment({
        resource: { id: freshCart.id, version: freshCart.version },
        paymentId: newPayment.id,
      })
      return newPayment
    } catch (err) {
      if (!paymentKey || !isDuplicateKeyError(err)) {
        throw err
      }
      return this.recoverPaymentAfterKeyConflict(ctCart, paymentKey, briqpaySessionId as string, err)
    }
  }

  /**
   * Creates a fresh CT Payment for the Briqpay session and attaches it to the cart, or — if
   * a concurrent caller already won the deterministic key — recovers by fetching the winning
   * Payment by key and attaching it to the cart instead.
   *
   * Used by handleTransaction when the cheap interfaceId-based dedupe missed (search index
   * lag during a true concurrency burst).
   */
  private async createOrRecoverPaymentForTransaction(
    ctCart: Cart,
    briqpaySessionId: string,
    amountPlanned: Money,
    paymentInterface: string,
  ): Promise<Payment> {
    const paymentKey = buildPaymentKey(briqpaySessionId)
    try {
      const newPayment = await this.ctPaymentService.createPayment({
        key: paymentKey,
        amountPlanned,
        paymentMethodInfo: { paymentInterface },
        checkoutTransactionItemId: getCheckoutTransactionItemIdFromContext(),
        interfaceId: briqpaySessionId,
      })

      const freshCart = await this.ctCartService.getCart({ id: ctCart.id })
      await this.ctCartService.addPayment({
        resource: { id: freshCart.id, version: freshCart.version },
        paymentId: newPayment.id,
      })

      return newPayment
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err
      }
      return this.recoverPaymentAfterKeyConflict(ctCart, paymentKey, briqpaySessionId, err)
    }
  }

  /**
   * Looks up the Payment that won the createPayment race (identified by `paymentKey`),
   * attaches it to the cart if needed, and returns it. Re-throws the original CT error if
   * the Payment cannot be found by key (unexpected — would indicate a CT-side inconsistency).
   */
  private async recoverPaymentAfterKeyConflict(
    ctCart: Cart,
    paymentKey: string,
    briqpaySessionId: string,
    originalErr: unknown,
  ): Promise<Payment> {
    appLogger.info(
      { paymentKey, cartId: ctCart.id, briqpaySessionId },
      'concurrent dedupe — DuplicateField on key, recovering by lookup',
    )
    const recovered = await this.fetchPaymentByKey(paymentKey)
    if (!recovered) {
      appLogger.error(
        { paymentKey, cartId: ctCart.id },
        'DuplicateField on key but Payment not found by key — re-throwing original error',
      )
      throw originalErr
    }
    await this.attachPaymentToCartIfNeeded(ctCart, recovered.id)
    return recovered
  }

  /**
   * Fetches a Payment by its `key`. Returns undefined when no Payment exists with that key
   * (404). Other errors propagate.
   *
   * Note: connect-payments-sdk re-exports the platform-sdk `Payment` type verbatim
   * (commercetools/types/payment.type.d.ts), so the response body is already correctly typed
   * — no cast needed.
   */
  private async fetchPaymentByKey(key: string): Promise<Payment | undefined> {
    try {
      const response = await apiRoot.payments().withKey({ key }).get().execute()
      return response.body
    } catch (err) {
      if (isNotFoundError(err)) {
        return undefined
      }
      throw err
    }
  }

  /**
   * Ensures the given Payment is attached to the cart. Re-fetches the cart for a fresh
   * version, checks whether the Payment is already linked, and only calls addPayment if
   * not. If addPayment fails but a re-check shows the Payment is now on the cart (a
   * concurrent caller won), it treats the situation as success rather than an error.
   */
  private async attachPaymentToCartIfNeeded(cart: Cart, paymentId: string): Promise<void> {
    const freshCart = await this.ctCartService.getCart({ id: cart.id })
    if (freshCart.paymentInfo?.payments?.some((p) => p.id === paymentId)) {
      return
    }
    try {
      await this.ctCartService.addPayment({
        resource: { id: freshCart.id, version: freshCart.version },
        paymentId,
      })
    } catch (err) {
      const recheck = await this.ctCartService.getCart({ id: cart.id })
      if (recheck.paymentInfo?.payments?.some((p) => p.id === paymentId)) {
        appLogger.info(
          { paymentId, cartId: cart.id },
          'attachPaymentToCartIfNeeded: addPayment errored but Payment is now attached — treating as success',
        )
        return
      }
      throw err
    }
  }

  /**
   * Removes any other Briqpay-owned Payments from the cart, leaving only the one
   * identified by `currentPaymentId`. Best-effort and idempotent — failures are
   * logged but never propagated to the caller, since this runs after the
   * customer's payment has already succeeded.
   *
   * Safety: a candidate Payment is preserved (NOT detached) if it has any
   * Authorization transaction in state Success or Pending. Real or in-flight
   * authorizations must never be silently dropped from the cart.
   */
  private async detachStaleBriqpayPayments(
    cartId: string,
    currentPaymentId: string,
    paymentInterface: string,
  ): Promise<void> {
    try {
      const candidates = await this.loadDetachCandidates(cartId, currentPaymentId)
      if (candidates.length === 0) return

      const toDetach = this.selectDetachableCandidates(candidates, paymentInterface, cartId, currentPaymentId)
      if (toDetach.length === 0) return

      await this.removePaymentsFromCartWithRetry(cartId, currentPaymentId, toDetach)
    } catch (err) {
      appLogger.error(
        { err, cartId, currentPaymentId },
        'Failed to detach stale Briqpay Payments — cart may still have multiple Payments. Will retry on next invocation.',
      )
    }
  }

  /**
   * Loads candidate Payments potentially eligible for detach: every Payment currently on the
   * cart except `currentPaymentId`. Tolerates individual fetch failures (logs them at warn
   * level and skips the affected ids) so a single 404/transient failure does not block detach
   * of the remaining Payments. Returns `[]` when there are no candidate ids to fetch.
   */
  private async loadDetachCandidates(cartId: string, currentPaymentId: string): Promise<Payment[]> {
    const cart = await this.ctCartService.getCart({ id: cartId })
    const candidateIds = (cart.paymentInfo?.payments ?? []).map((p) => p.id).filter((id) => id !== currentPaymentId)

    if (candidateIds.length === 0) return []

    const candidatesSettled = await Promise.allSettled(
      candidateIds.map((id) => this.ctPaymentService.getPayment({ id })),
    )

    const failedFetches = candidatesSettled
      .map((r, idx) => ({ result: r, id: candidateIds[idx] }))
      .filter((x): x is { result: PromiseRejectedResult; id: string } => x.result.status === 'rejected')
    if (failedFetches.length > 0) {
      appLogger.warn(
        {
          cartId,
          currentPaymentId,
          failedPaymentIds: failedFetches.map((f) => f.id),
          errors: failedFetches.map((f) => f.result.reason),
        },
        'Could not fetch some candidate Payments during detach — they will be skipped',
      )
    }

    return candidatesSettled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  }

  /**
   * Applies the safety + ownership filters that decide which candidates may be detached:
   * we only ever touch Payments that are ours (matching paymentInterface AND keyed with the
   * Briqpay prefix), and we always preserve any Payment with an in-progress (Pending) or
   * successful Authorization. Emits a warn log per preserved Payment so the operator can see
   * why a Payment was left attached. Returns the subset that may be safely removed.
   */
  private selectDetachableCandidates(
    candidates: Payment[],
    paymentInterface: string,
    cartId: string,
    currentPaymentId: string,
  ): Payment[] {
    const hasInProgressOrSuccessfulAuth = (p: Payment): boolean =>
      p.transactions?.some((tx) => tx.type === 'Authorization' && (tx.state === 'Success' || tx.state === 'Pending')) ??
      false

    const isOurOwnedPayment = (p: Payment): boolean =>
      p.paymentMethodInfo?.paymentInterface === paymentInterface && (p.key?.startsWith(PAYMENT_KEY_PREFIX) ?? false)

    const toDetach = candidates.filter((p) => isOurOwnedPayment(p) && !hasInProgressOrSuccessfulAuth(p))
    const preserved = candidates.filter((p) => isOurOwnedPayment(p) && hasInProgressOrSuccessfulAuth(p))

    for (const p of preserved) {
      const authState = p.transactions?.find(
        (tx) => tx.type === 'Authorization' && (tx.state === 'Success' || tx.state === 'Pending'),
      )?.state
      appLogger.warn(
        { cartId, currentPaymentId, preservedPaymentId: p.id, authState },
        'Preserved stale Briqpay Payment from cart due to in-progress or successful Authorization',
      )
    }

    return toDetach
  }

  /**
   * Issues the atomic `removePayment` cart update for `toDetach`, retrying up to 3 times on
   * 409 conflicts with exponential backoff + jitter. Each attempt re-fetches the cart for a
   * fresh version and re-filters `toDetach` against the cart's current payment list, so a
   * concurrent detach by another caller short-circuits cleanly. Non-409 errors and a final-
   * attempt 409 are re-thrown to the outer try/catch in `detachStaleBriqpayPayments`.
   */
  private async removePaymentsFromCartWithRetry(
    cartId: string,
    currentPaymentId: string,
    toDetach: Payment[],
  ): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const freshCart = await this.ctCartService.getCart({ id: cartId })
      const cartPaymentIds = new Set((freshCart.paymentInfo?.payments ?? []).map((p) => p.id))
      const stillAttached = toDetach.filter((p) => cartPaymentIds.has(p.id))

      if (stillAttached.length === 0) {
        appLogger.info(
          { cartId, currentPaymentId, originallyToDetach: toDetach.map((p) => p.id) },
          'Stale Briqpay Payments already detached by concurrent process — nothing to do',
        )
        return
      }

      try {
        await apiRoot
          .carts()
          .withId({ ID: freshCart.id })
          .post({
            body: {
              version: freshCart.version,
              actions: stillAttached.map((p) => ({
                action: 'removePayment' as const,
                payment: { typeId: 'payment' as const, id: p.id },
              })),
            },
          })
          .execute()

        appLogger.info(
          { cartId, currentPaymentId, detachedPaymentIds: stillAttached.map((p) => p.id) },
          'Detached stale Briqpay Payments from cart',
        )
        return
      } catch (err) {
        const e = err as CtErrorShape
        const isConflict = e?.statusCode === 409 || e?.httpErrorStatus === 409
        if (!isConflict || attempt === maxAttempts - 1) throw err
        const jitterMs = Math.floor(Math.random() * 100)
        const delayMs = Math.min(100 * Math.pow(2, attempt) + jitterMs, 2000)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
}
