import {
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  ErrorInvalidOperation,
  TransactionState,
  TransactionType,
} from '@commercetools/connect-payments-sdk'
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
  getFutureOrderNumberFromContext,
  getPaymentInterfaceFromContext,
} from '../../libs/fastify/context/context'
import { randomUUID } from 'crypto'
import { appLogger } from '../../payment-sdk'
import Briqpay from '../../libs/briqpay/BriqpayService'
import { convertPaymentModificationStatusCode, convertPaymentResultCode } from './utils'
import { SessionError, ValidationError } from '../../libs/errors/briqpay-errors'

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
      ctCart,
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

    // Re-fetch cart to get the current version (cart may have been modified by session service)
    const freshCart = await this.ctCartService.getCart({
      id: ctCart.id,
    })

    await this.ctCartService.addPayment({
      resource: {
        id: freshCart.id,
        version: freshCart.version,
      },
      paymentId: ctPayment.id,
    })

    const pspReference = freshCart.custom?.fields?.['briqpaySessionId']

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: pspReference,
      paymentMethod: request.data.paymentMethod.type,
      transaction: {
        type: 'Authorization',
        amount: ctPayment.amountPlanned,
        interactionId: pspReference,
        state: convertPaymentResultCode(request.data.paymentOutcome),
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

    // Log the futureOrderNumber from both the transaction DTO and the context
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

    const isBelowSuccessStateThreshold = amountPlanned.centAmount < maxCentAmountIfSuccess

    const newlyCreatedPayment = await this.ctPaymentService.createPayment({
      amountPlanned,
      paymentMethodInfo: {
        paymentInterface: transactionDraft.paymentInterface,
      },
    })

    // Re-fetch cart to get the current version (cart may have been modified)
    const freshCart = await this.ctCartService.getCart({
      id: ctCart.id,
    })

    await this.ctCartService.addPayment({
      resource: {
        id: freshCart.id,
        version: freshCart.version,
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
}
