import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { toBriqpayAmount, toCtCentAmount } from '../../../src/libs/briqpay/amount-precision'
import { ValidationError } from '../../../src/libs/errors/briqpay-errors'
import { appLogger } from '../../../src/payment-sdk'

beforeEach(() => {
  jest.spyOn(appLogger, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('toBriqpayAmount', () => {
  it.each([
    [10000, 0, 1000000], // 10,000 ISK / JPY / KRW
    [119000, 2, 119000], // EUR unchanged
    [12345, 1, 123450],
  ])('converts %i with %i fraction digits to %i', (amount, digits, expected) => {
    expect(toBriqpayAmount(amount, digits)).toBe(expected)
  })

  it.each([3, -1, 1.5, Number.NaN])('rejects %p fraction digits', (digits) => {
    expect(() => toBriqpayAmount(1000, digits)).toThrow(ValidationError)
  })
})

describe('toCtCentAmount', () => {
  it('converts a whole Briqpay amount back without logging', () => {
    expect(toCtCentAmount(1000000, 0)).toBe(10000)
    expect(toCtCentAmount(119000, 2)).toBe(119000)
    expect(appLogger.error).not.toHaveBeenCalled()
  })

  it('rounds a non-whole amount and logs it', () => {
    expect(toCtCentAmount(5050, 0)).toBe(51)
    expect(appLogger.error).toHaveBeenCalledWith(
      { briqpayAmount: 5050, fractionDigits: 0, centAmount: 51 },
      'Briqpay amount is finer than the commercetools currency, rounded',
    )
  })

  it('rejects 3 fraction digits', () => {
    expect(() => toCtCentAmount(1000, 3)).toThrow(ValidationError)
  })
})
