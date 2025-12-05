import { TransactionState } from '@commercetools/connect-payments-sdk'
import { BRIQPAY_WEBHOOK_STATUS, PaymentOutcome } from '../../dtos/briqpay-payment.dto'
import { PaymentModificationStatus } from '../../dtos/operations/payment-intents.dto'

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
