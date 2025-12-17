import { describe, expect, test, afterEach } from '@jest/globals'
import crypto from 'crypto'
import {
  verifyBriqpayWebhook,
  isHmacVerificationEnabled,
  getWebhookSecret,
} from '../../../src/libs/briqpay/webhook-verification'

describe('webhook-verification', () => {
  const testSecret = 'test-webhook-secret-12345'
  const testBody = '{"event":"capture_status","status":"approved","sessionId":"test-session-123"}'

  /**
   * Helper to generate a valid signature header for testing
   */
  const generateValidSignature = (body: string, secret: string, timestampMs?: number): string => {
    const timestamp = timestampMs ?? Date.now()
    const signedPayload = `${timestamp}.${body}`
    const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('base64')
    return `t=${timestamp},s1=${signature}`
  }

  describe('verifyBriqpayWebhook', () => {
    test('should return valid for correct signature', () => {
      const signatureHeader = generateValidSignature(testBody, testSecret)

      const result = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    test('should return invalid for incorrect signature', () => {
      const signatureHeader = generateValidSignature(testBody, 'wrong-secret')

      const result = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Signature validation failed')
    })

    test('should return invalid for tampered body', () => {
      const signatureHeader = generateValidSignature(testBody, testSecret)
      const tamperedBody = '{"event":"capture_status","status":"rejected","sessionId":"test-session-123"}'

      const result = verifyBriqpayWebhook(tamperedBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Signature validation failed')
    })

    test('should return invalid for malformed signature header - missing parts', () => {
      const result = verifyBriqpayWebhook(testBody, 't=12345', testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Invalid signature header format')
    })

    test('should return invalid for malformed signature header - wrong format', () => {
      const result = verifyBriqpayWebhook(testBody, 'invalid-header-format', testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Invalid signature header format')
    })

    test('should return invalid for malformed signature header - missing timestamp prefix', () => {
      const result = verifyBriqpayWebhook(testBody, 'x=12345,s1=abc', testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Invalid signature header format')
    })

    test('should return invalid for malformed signature header - missing signature prefix', () => {
      const result = verifyBriqpayWebhook(testBody, 't=12345,x=abc', testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Invalid signature header format')
    })

    test('should return invalid for non-numeric timestamp', () => {
      const result = verifyBriqpayWebhook(testBody, 't=not-a-number,s1=abc123', testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Invalid timestamp')
    })

    test('should return invalid for expired timestamp (replay attack prevention)', () => {
      const sixMinutesAgo = Date.now() - 6 * 60 * 1000
      const signatureHeader = generateValidSignature(testBody, testSecret, sixMinutesAgo)

      const result = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Timestamp validation failed - webhook too old')
    })

    test('should return valid for timestamp within tolerance', () => {
      const fourMinutesAgo = Date.now() - 4 * 60 * 1000
      const signatureHeader = generateValidSignature(testBody, testSecret, fourMinutesAgo)

      const result = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(true)
    })

    test('should return invalid for future timestamp (clock skew attack prevention)', () => {
      const twoMinutesInFuture = Date.now() + 2 * 60 * 1000
      const signatureHeader = generateValidSignature(testBody, testSecret, twoMinutesInFuture)

      const result = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Timestamp validation failed - webhook from the future')
    })

    test('should accept custom tolerance', () => {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000
      const signatureHeader = generateValidSignature(testBody, testSecret, tenMinutesAgo)

      // Default 5-minute tolerance should fail
      const resultDefault = verifyBriqpayWebhook(testBody, signatureHeader, testSecret)
      expect(resultDefault.isValid).toBe(false)

      // Custom 15-minute tolerance should pass
      const resultCustom = verifyBriqpayWebhook(testBody, signatureHeader, testSecret, 15 * 60 * 1000)
      expect(resultCustom.isValid).toBe(true)
    })

    test('should handle empty body', () => {
      const emptyBody = ''
      const signatureHeader = generateValidSignature(emptyBody, testSecret)

      const result = verifyBriqpayWebhook(emptyBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(true)
    })

    test('should handle special characters in body', () => {
      const specialBody = '{"message":"Hello \\"World\\"","emoji":"🎉","unicode":"日本語"}'
      const signatureHeader = generateValidSignature(specialBody, testSecret)

      const result = verifyBriqpayWebhook(specialBody, signatureHeader, testSecret)

      expect(result.isValid).toBe(true)
    })
  })

  describe('isHmacVerificationEnabled', () => {
    const originalEnv = process.env.BRIQPAY_WEBHOOK_SECRET

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.BRIQPAY_WEBHOOK_SECRET = originalEnv
      } else {
        delete process.env.BRIQPAY_WEBHOOK_SECRET
      }
    })

    test('should return true when BRIQPAY_WEBHOOK_SECRET is set', () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = 'some-secret'

      expect(isHmacVerificationEnabled()).toBe(true)
    })

    test('should return false when BRIQPAY_WEBHOOK_SECRET is not set', () => {
      delete process.env.BRIQPAY_WEBHOOK_SECRET

      expect(isHmacVerificationEnabled()).toBe(false)
    })

    test('should return false when BRIQPAY_WEBHOOK_SECRET is empty string', () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = ''

      expect(isHmacVerificationEnabled()).toBe(false)
    })
  })

  describe('getWebhookSecret', () => {
    const originalEnv = process.env.BRIQPAY_WEBHOOK_SECRET

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.BRIQPAY_WEBHOOK_SECRET = originalEnv
      } else {
        delete process.env.BRIQPAY_WEBHOOK_SECRET
      }
    })

    test('should return the secret when set', () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = 'my-secret-value'

      expect(getWebhookSecret()).toBe('my-secret-value')
    })

    test('should return undefined when not set', () => {
      delete process.env.BRIQPAY_WEBHOOK_SECRET

      expect(getWebhookSecret()).toBeUndefined()
    })
  })
})
