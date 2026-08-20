import { describe, expect, test } from '@jest/globals'
import { Errorx } from '@commercetools/connect-payments-sdk'
import { BriqpayError, SessionError, ValidationError, UpstreamError } from '../../../src/libs/errors/briqpay-errors'

describe('briqpay-errors', () => {
  describe('BriqpayError', () => {
    test('should create error with default values', () => {
      const error = new BriqpayError('Test error')
      expect(error.message).toBe('Test error')
      expect(error.httpErrorStatus).toBe(500)
      expect(error.code).toBe('INTERNAL_SERVER_ERROR')
      expect(error.name).toBe('BriqpayError')
    })

    test('should create error with custom values', () => {
      const error = new BriqpayError('Custom error', 404, 'NOT_FOUND')
      expect(error.message).toBe('Custom error')
      expect(error.httpErrorStatus).toBe(404)
      expect(error.code).toBe('NOT_FOUND')
    })

    // The error handler dispatches on `instanceof Errorx`. If this inheritance is
    // ever broken, every connector error reaches clients as 500 "Internal server error."
    test('is an Errorx so the global error handler serializes it with its real status', () => {
      expect(new BriqpayError('Test error')).toBeInstanceOf(Errorx)
      expect(new ValidationError('Invalid input')).toBeInstanceOf(Errorx)
    })
  })

  describe('SessionError', () => {
    test('should create session error with default status code', () => {
      const error = new SessionError('Session expired')
      expect(error.message).toBe('Session expired')
      expect(error.httpErrorStatus).toBe(500)
      expect(error.code).toBe('SESSION_ERROR')
      expect(error.name).toBe('SessionError')
    })

    test('should create session error with custom status code', () => {
      const error = new SessionError('Session not found', 404)
      expect(error.message).toBe('Session not found')
      expect(error.httpErrorStatus).toBe(404)
      expect(error.code).toBe('SESSION_ERROR')
    })
  })

  describe('ValidationError', () => {
    test('should create validation error with correct defaults', () => {
      const error = new ValidationError('Invalid input')
      expect(error.message).toBe('Invalid input')
      expect(error.httpErrorStatus).toBe(400)
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.name).toBe('ValidationError')
    })
  })

  describe('UpstreamError', () => {
    test('should create upstream error without original error', () => {
      const error = new UpstreamError('Upstream service failed')
      expect(error.message).toBe('Upstream service failed')
      expect(error.httpErrorStatus).toBe(502)
      expect(error.code).toBe('UPSTREAM_ERROR')
      expect(error.name).toBe('UpstreamError')
      expect(error.cause).toBeUndefined()
    })

    test('should create upstream error with original Error as cause', () => {
      const originalError = new Error('Original failure')
      const error = new UpstreamError('Upstream service failed', originalError)
      expect(error.message).toBe('Upstream service failed')
      expect(error.httpErrorStatus).toBe(502)
      expect(error.code).toBe('UPSTREAM_ERROR')
      expect(error.cause).toBe(originalError)
    })

    test('should not set cause when originalError is not an Error instance', () => {
      const error = new UpstreamError('Upstream service failed', 'string error')
      expect(error.message).toBe('Upstream service failed')
      expect(error.httpErrorStatus).toBe(502)
      expect(error.cause).toBeUndefined()
    })
  })
})
