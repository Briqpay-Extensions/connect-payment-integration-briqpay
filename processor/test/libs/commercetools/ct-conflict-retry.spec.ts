import { describe, expect, test, jest } from '@jest/globals'
import CtConflictRetry from '../../../src/libs/commercetools/ct-conflict-retry'

describe('CtConflictRetry', () => {
  describe('isConflict', () => {
    test('is true for a 409 on either status property', () => {
      expect(CtConflictRetry.isConflict({ statusCode: 409 })).toBe(true)
      expect(CtConflictRetry.isConflict({ httpErrorStatus: 409 })).toBe(true)
    })

    test('is false for other statuses and non-object errors', () => {
      expect(CtConflictRetry.isConflict({ statusCode: 404 })).toBe(false)
      expect(CtConflictRetry.isConflict({ httpErrorStatus: 400 })).toBe(false)
      expect(CtConflictRetry.isConflict(null)).toBe(false)
      expect(CtConflictRetry.isConflict('conflict')).toBe(false)
    })
  })

  describe('isNotFound', () => {
    test('is true for a 404 on either status property', () => {
      expect(CtConflictRetry.isNotFound({ statusCode: 404 })).toBe(true)
      expect(CtConflictRetry.isNotFound({ httpErrorStatus: 404 })).toBe(true)
    })

    test('is false for other statuses and non-object errors', () => {
      expect(CtConflictRetry.isNotFound({ statusCode: 409 })).toBe(false)
      expect(CtConflictRetry.isNotFound(undefined)).toBe(false)
      expect(CtConflictRetry.isNotFound(404)).toBe(false)
    })
  })

  describe('isInvalidOperation', () => {
    test('is true for a 400 with InvalidOperation code (top-level or in fields)', () => {
      expect(CtConflictRetry.isInvalidOperation({ statusCode: 400, code: 'InvalidOperation' })).toBe(true)
      expect(CtConflictRetry.isInvalidOperation({ httpErrorStatus: 400, code: 'InvalidOperation' })).toBe(true)
      expect(CtConflictRetry.isInvalidOperation({ statusCode: 400, fields: [{ code: 'InvalidOperation' }] })).toBe(true)
    })

    test('is false for a 400 without the InvalidOperation code, or other statuses', () => {
      expect(CtConflictRetry.isInvalidOperation({ statusCode: 400, code: 'InvalidInput' })).toBe(false)
      expect(CtConflictRetry.isInvalidOperation({ statusCode: 409, code: 'InvalidOperation' })).toBe(false)
      expect(CtConflictRetry.isInvalidOperation({ statusCode: 404 })).toBe(false)
      expect(CtConflictRetry.isInvalidOperation(null)).toBe(false)
    })
  })

  describe('withConflictRetry', () => {
    test('returns the result on first success without retrying', async () => {
      const run = jest.fn<() => Promise<string>>().mockResolvedValue('ok')

      const result = await CtConflictRetry.withConflictRetry(run)

      expect(result).toBe('ok')
      expect(run).toHaveBeenCalledTimes(1)
    })

    test('retries on 409 then returns the eventual success', async () => {
      const conflict = Object.assign(new Error('conflict'), { statusCode: 409 })
      const run = jest.fn<() => Promise<number>>().mockRejectedValueOnce(conflict).mockResolvedValueOnce(7)

      const result = await CtConflictRetry.withConflictRetry(run, 3)

      expect(result).toBe(7)
      expect(run).toHaveBeenCalledTimes(2)
    })

    test('rethrows immediately on non-409 errors', async () => {
      const boom = Object.assign(new Error('boom'), { statusCode: 400 })
      const run = jest.fn<() => Promise<void>>().mockRejectedValue(boom)

      await expect(CtConflictRetry.withConflictRetry(run, 3)).rejects.toBe(boom)
      expect(run).toHaveBeenCalledTimes(1)
    })

    test('rethrows the conflict after exhausting maxAttempts', async () => {
      const conflict = Object.assign(new Error('conflict'), { httpErrorStatus: 409 })
      const run = jest.fn<() => Promise<void>>().mockRejectedValue(conflict)

      await expect(CtConflictRetry.withConflictRetry(run, 2)).rejects.toBe(conflict)
      expect(run).toHaveBeenCalledTimes(2)
    })
  })
})
