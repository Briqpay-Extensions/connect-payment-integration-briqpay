import { TransactionState } from '@commercetools/connect-payments-sdk'
import { BRIQPAY_WEBHOOK_STATUS, PaymentOutcome } from '../../dtos/briqpay-payment.dto'
import { PaymentModificationStatus } from '../../dtos/operations/payment-intents.dto'
import { MediumBriqpayResponse, ORDER_STATUS, TRANSACTION_STATUS } from '../types/briqpay-payment.type'

export const convertNotificationStatus = (resultCode: BRIQPAY_WEBHOOK_STATUS): TransactionState => {
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

export const convertPaymentResultCode = (resultCode: PaymentOutcome): string => {
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

export const convertPaymentModificationStatusCode = (resultCode: PaymentOutcome): PaymentModificationStatus => {
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

/**
 * Extracts the actual order status from the Briqpay session's moduleStatus.
 * This is the source of truth for order status - use this instead of webhook payload
 * until HMAC webhook validation is enabled.
 *
 * @param session - The Briqpay session response
 * @returns The actual order status from moduleStatus.payment.orderStatus
 */
export const getActualOrderStatus = (session: MediumBriqpayResponse): ORDER_STATUS | undefined => {
  return session.moduleStatus?.payment?.orderStatus
}

/**
 * Converts ORDER_STATUS enum to BRIQPAY_WEBHOOK_STATUS for compatibility with existing handlers.
 * This allows us to use the actual status from the session while keeping the existing
 * transaction state conversion logic.
 *
 * @param orderStatus - The order status from moduleStatus
 * @returns The equivalent BRIQPAY_WEBHOOK_STATUS
 */
export const orderStatusToWebhookStatus = (orderStatus: ORDER_STATUS): BRIQPAY_WEBHOOK_STATUS => {
  switch (orderStatus) {
    case ORDER_STATUS.ORDER_PENDING:
      return BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING
    case ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED:
      return BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED
    case ORDER_STATUS.ORDER_REJECTED:
      return BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED
    case ORDER_STATUS.ORDER_CANCELLED:
      return BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED
    default:
      return BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING
  }
}

/**
 * Converts TRANSACTION_STATUS enum to BRIQPAY_WEBHOOK_STATUS for compatibility with existing handlers.
 * Used for capture and refund status conversion.
 *
 * @param transactionStatus - The transaction status from captures/refunds array
 * @returns The equivalent BRIQPAY_WEBHOOK_STATUS
 */
export const transactionStatusToWebhookStatus = (transactionStatus: TRANSACTION_STATUS): BRIQPAY_WEBHOOK_STATUS => {
  switch (transactionStatus) {
    case TRANSACTION_STATUS.APPROVED:
      return BRIQPAY_WEBHOOK_STATUS.APPROVED
    case TRANSACTION_STATUS.PENDING:
      return BRIQPAY_WEBHOOK_STATUS.PENDING
    case TRANSACTION_STATUS.REJECTED:
      return BRIQPAY_WEBHOOK_STATUS.REJECTED
    case TRANSACTION_STATUS.CANCELLED:
      return BRIQPAY_WEBHOOK_STATUS.REJECTED // Map cancelled to rejected for CT transaction state
    default:
      return BRIQPAY_WEBHOOK_STATUS.PENDING
  }
}

/**
 * Finds a capture by ID in the session's captures array and returns its actual status.
 *
 * @param session - The Briqpay session response
 * @param captureId - The capture ID to find
 * @returns The capture's actual status, or undefined if not found
 */
export const getActualCaptureStatus = (
  session: MediumBriqpayResponse,
  captureId: string,
): TRANSACTION_STATUS | undefined => {
  const capture = session.captures?.find((c) => c.captureId === captureId)
  return capture?.status
}

/**
 * Finds a refund by ID in the session's refunds array and returns its actual status.
 *
 * @param session - The Briqpay session response
 * @param refundId - The refund ID to find
 * @returns The refund's actual status, or undefined if not found
 */
export const getActualRefundStatus = (
  session: MediumBriqpayResponse,
  refundId: string,
): TRANSACTION_STATUS | undefined => {
  const refund = session.refunds?.find((r) => r.refundId === refundId)
  return refund?.status
}
