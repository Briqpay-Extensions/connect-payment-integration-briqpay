import { describe, expect, test } from '@jest/globals'
import {
  convertNotificationStatus,
  convertPaymentResultCode,
  convertPaymentModificationStatusCode,
} from '../../../src/services/briqpay/utils'
import { BRIQPAY_WEBHOOK_STATUS, PaymentOutcome } from '../../../src/dtos/briqpay-payment.dto'
import { PaymentModificationStatus } from '../../../src/dtos/operations/payment-intents.dto'

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
})
