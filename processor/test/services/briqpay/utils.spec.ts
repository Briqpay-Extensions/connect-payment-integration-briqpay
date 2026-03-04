import { describe, expect, test } from '@jest/globals'
import {
  convertNotificationStatus,
  convertPaymentResultCode,
  convertPaymentModificationStatusCode,
  getActualOrderStatus,
  orderStatusToWebhookStatus,
  transactionStatusToWebhookStatus,
  getTransaction,
  getActualAuthorizationStatus,
  getCapture,
  getActualCaptureStatus,
  getRefund,
  getActualRefundStatus,
} from '../../../src/services/briqpay/utils'
import { BRIQPAY_WEBHOOK_STATUS, PaymentOutcome } from '../../../src/dtos/briqpay-payment.dto'
import { PaymentModificationStatus } from '../../../src/dtos/operations/payment-intents.dto'
import {
  MediumBriqpayResponse,
  ORDER_STATUS,
  TRANSACTION_STATUS,
} from '../../../src/services/types/briqpay-payment.type'

describe('briqpay utils', () => {
  describe('convertNotificationStatus', () => {
    test('should return Success for ORDER_APPROVED_NOT_CAPTURED', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED)).toBe('Success')
    })

    test('should return Success for APPROVED', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.APPROVED)).toBe('Success')
    })

    test('should return Pending for ORDER_PENDING', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING)).toBe('Pending')
    })

    test('should return Pending for PENDING', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.PENDING)).toBe('Pending')
    })

    test('should return Failure for ORDER_REJECTED', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED)).toBe('Failure')
    })

    test('should return Failure for ORDER_CANCELLED', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED)).toBe('Failure')
    })

    test('should return Failure for REJECTED', () => {
      expect(convertNotificationStatus(BRIQPAY_WEBHOOK_STATUS.REJECTED)).toBe('Failure')
    })

    test('should return Pending for unknown status (default)', () => {
      expect(convertNotificationStatus('UNKNOWN_STATUS' as BRIQPAY_WEBHOOK_STATUS)).toBe('Pending')
    })
  })

  describe('convertPaymentResultCode', () => {
    test('should return Success for APPROVED', () => {
      expect(convertPaymentResultCode(PaymentOutcome.APPROVED)).toBe('Success')
    })

    test('should return Pending for PENDING', () => {
      expect(convertPaymentResultCode(PaymentOutcome.PENDING)).toBe('Pending')
    })

    test('should return Failure for REJECTED', () => {
      expect(convertPaymentResultCode(PaymentOutcome.REJECTED)).toBe('Failure')
    })

    test('should return Pending for unknown outcome (default)', () => {
      expect(convertPaymentResultCode('UNKNOWN' as PaymentOutcome)).toBe('Pending')
    })
  })

  describe('convertPaymentModificationStatusCode', () => {
    test('should return APPROVED for APPROVED', () => {
      expect(convertPaymentModificationStatusCode(PaymentOutcome.APPROVED)).toBe(PaymentModificationStatus.APPROVED)
    })

    test('should return RECEIVED for PENDING', () => {
      expect(convertPaymentModificationStatusCode(PaymentOutcome.PENDING)).toBe(PaymentModificationStatus.RECEIVED)
    })

    test('should return REJECTED for REJECTED', () => {
      expect(convertPaymentModificationStatusCode(PaymentOutcome.REJECTED)).toBe(PaymentModificationStatus.REJECTED)
    })

    test('should return RECEIVED for unknown outcome (default)', () => {
      expect(convertPaymentModificationStatusCode('UNKNOWN' as PaymentOutcome)).toBe(PaymentModificationStatus.RECEIVED)
    })
  })

  describe('getActualOrderStatus', () => {
    test('should return orderStatus from moduleStatus.payment', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        moduleStatus: { payment: { orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED } },
      }
      expect(getActualOrderStatus(session)).toBe(ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED)
    })

    test('should return undefined when moduleStatus is absent', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getActualOrderStatus(session)).toBeUndefined()
    })

    test('should return undefined when moduleStatus.payment is absent', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1', moduleStatus: {} }
      expect(getActualOrderStatus(session)).toBeUndefined()
    })
  })

  describe('orderStatusToWebhookStatus', () => {
    test('should map ORDER_PENDING', () => {
      expect(orderStatusToWebhookStatus(ORDER_STATUS.ORDER_PENDING)).toBe(BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING)
    })

    test('should map ORDER_APPROVED_NOT_CAPTURED', () => {
      expect(orderStatusToWebhookStatus(ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED)).toBe(
        BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      )
    })

    test('should map ORDER_REJECTED', () => {
      expect(orderStatusToWebhookStatus(ORDER_STATUS.ORDER_REJECTED)).toBe(BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED)
    })

    test('should map ORDER_CANCELLED', () => {
      expect(orderStatusToWebhookStatus(ORDER_STATUS.ORDER_CANCELLED)).toBe(BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED)
    })

    test('should return ORDER_PENDING for unknown status (default)', () => {
      expect(orderStatusToWebhookStatus('UNKNOWN' as ORDER_STATUS)).toBe(BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING)
    })
  })

  describe('transactionStatusToWebhookStatus', () => {
    test('should map APPROVED', () => {
      expect(transactionStatusToWebhookStatus(TRANSACTION_STATUS.APPROVED)).toBe(BRIQPAY_WEBHOOK_STATUS.APPROVED)
    })

    test('should map PENDING', () => {
      expect(transactionStatusToWebhookStatus(TRANSACTION_STATUS.PENDING)).toBe(BRIQPAY_WEBHOOK_STATUS.PENDING)
    })

    test('should map REJECTED', () => {
      expect(transactionStatusToWebhookStatus(TRANSACTION_STATUS.REJECTED)).toBe(BRIQPAY_WEBHOOK_STATUS.REJECTED)
    })

    test('should map CANCELLED to REJECTED', () => {
      expect(transactionStatusToWebhookStatus(TRANSACTION_STATUS.CANCELLED)).toBe(BRIQPAY_WEBHOOK_STATUS.REJECTED)
    })

    test('should return PENDING for unknown status (default)', () => {
      expect(transactionStatusToWebhookStatus('UNKNOWN' as TRANSACTION_STATUS)).toBe(BRIQPAY_WEBHOOK_STATUS.PENDING)
    })
  })

  describe('getTransaction', () => {
    test('should return the first transaction', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          transactions: [
            { transactionId: 'tx-1', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 1000, currency: 'EUR' },
            { transactionId: 'tx-2', status: TRANSACTION_STATUS.PENDING, amountIncVat: 500, currency: 'EUR' },
          ],
        },
      }
      expect(getTransaction(session)?.transactionId).toBe('tx-1')
    })

    test('should return undefined when no transactions exist', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1', data: { transactions: [] } }
      expect(getTransaction(session)).toBeUndefined()
    })

    test('should return undefined when data is absent', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getTransaction(session)).toBeUndefined()
    })
  })

  describe('getActualAuthorizationStatus', () => {
    test('should return the status of the first transaction', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          transactions: [
            { transactionId: 'tx-1', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 1000, currency: 'EUR' },
          ],
        },
      }
      expect(getActualAuthorizationStatus(session)).toBe(TRANSACTION_STATUS.APPROVED)
    })

    test('should return undefined when no transactions exist', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getActualAuthorizationStatus(session)).toBeUndefined()
    })
  })

  describe('getCapture', () => {
    test('should find capture from data.captures', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          captures: [{ captureId: 'cap-1', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 1000, currency: 'EUR' }],
        },
      }
      expect(getCapture(session, 'cap-1')?.captureId).toBe('cap-1')
    })

    test('should fall back to top-level captures when not found in data.captures', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        captures: [
          { captureId: 'cap-legacy', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 800, currency: 'EUR' },
        ],
      }
      expect(getCapture(session, 'cap-legacy')?.captureId).toBe('cap-legacy')
    })

    test('should return undefined when capture is not found', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getCapture(session, 'missing')).toBeUndefined()
    })
  })

  describe('getActualCaptureStatus', () => {
    test('should return the status of a found capture', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          captures: [{ captureId: 'cap-1', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 1000, currency: 'EUR' }],
        },
      }
      expect(getActualCaptureStatus(session, 'cap-1')).toBe(TRANSACTION_STATUS.APPROVED)
    })

    test('should return undefined when capture is not found', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getActualCaptureStatus(session, 'missing')).toBeUndefined()
    })
  })

  describe('getRefund', () => {
    test('should find refund from data.refunds', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          refunds: [{ refundId: 'ref-1', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 500, currency: 'EUR' }],
        },
      }
      expect(getRefund(session, 'ref-1')?.refundId).toBe('ref-1')
    })

    test('should fall back to top-level refunds when not found in data.refunds', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        refunds: [{ refundId: 'ref-legacy', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 300, currency: 'EUR' }],
      }
      expect(getRefund(session, 'ref-legacy')?.refundId).toBe('ref-legacy')
    })

    test('should return undefined when refund is not found', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getRefund(session, 'missing')).toBeUndefined()
    })
  })

  describe('getActualRefundStatus', () => {
    test('should return the status of a found refund', () => {
      const session: MediumBriqpayResponse = {
        htmlSnippet: '',
        sessionId: 'sess-1',
        data: {
          refunds: [{ refundId: 'ref-1', status: TRANSACTION_STATUS.REJECTED, amountIncVat: 500, currency: 'EUR' }],
        },
      }
      expect(getActualRefundStatus(session, 'ref-1')).toBe(TRANSACTION_STATUS.REJECTED)
    })

    test('should return undefined when refund is not found', () => {
      const session: MediumBriqpayResponse = { htmlSnippet: '', sessionId: 'sess-1' }
      expect(getActualRefundStatus(session, 'missing')).toBeUndefined()
    })
  })
})
