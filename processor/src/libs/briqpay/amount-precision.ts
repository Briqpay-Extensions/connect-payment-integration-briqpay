import { appLogger } from '../../payment-sdk'
import { ValidationError } from '../errors/briqpay-errors'

// Briqpay holds every amount with 2 decimals, commercetools with the currency's own.
const briqpayScale = (fractionDigits: number): number => {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 2) {
    throw new ValidationError(
      `Unsupported currency precision: Briqpay takes at most 2 fraction digits, got ${fractionDigits}`,
    )
  }

  return 10 ** (2 - fractionDigits)
}

export const toBriqpayAmount = (centAmount: number, fractionDigits: number): number => {
  return centAmount * briqpayScale(fractionDigits)
}

export const toCtCentAmount = (briqpayAmount: number, fractionDigits: number): number => {
  const scale = briqpayScale(fractionDigits)
  const centAmount = Math.round(briqpayAmount / scale)

  if (briqpayAmount % scale !== 0) {
    appLogger.error(
      { briqpayAmount, fractionDigits, centAmount },
      'Briqpay amount is finer than the commercetools currency, rounded',
    )
  }

  return centAmount
}
