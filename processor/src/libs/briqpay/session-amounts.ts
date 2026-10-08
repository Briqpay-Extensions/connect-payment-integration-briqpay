import { MediumBriqpayResponse } from '../../services/types/briqpay-payment.type'
import { appLogger } from '../../payment-sdk'

export type BriqpayOrderAmounts = {
  currency: string
  amountIncVat: number
  amountExVat: number
}

/** The order amounts a session holds. For comparison and log payloads. */
export const readBriqpaySessionAmounts = (session: MediumBriqpayResponse): Partial<BriqpayOrderAmounts> => {
  const order = session.data?.order

  const amounts: Partial<BriqpayOrderAmounts> = {
    currency: order?.currency,
    amountIncVat: order?.amountIncVat,
    amountExVat: order?.amountExVat,
  }

  return amounts
}

// Exact on all three fields: Briqpay stores order amounts verbatim as sent, and both
// senders derive them through the same builder, so any real difference is a cart
// change - not rounding. No tolerance.
export const briqpaySessionAmountsEqual = (session: MediumBriqpayResponse, expected: BriqpayOrderAmounts): boolean => {
  const actual = readBriqpaySessionAmounts(session)

  return (
    actual.currency === expected.currency &&
    actual.amountIncVat === expected.amountIncVat &&
    actual.amountExVat === expected.amountExVat
  )
}

/**
 * Error-level log for any point where a Briqpay amount and the commercetools amount disagree.
 * Observability only; callers keep their own control flow. `context` names the call site so every
 * mismatch shares one greppable message and can be filtered by site.
 */
export const logAmountMismatch = (fields: {
  context: string
  cartId?: string
  sessionId?: string
  expected: unknown
  actual: unknown
}): void => {
  appLogger.error(
    {
      context: fields.context,
      cartId: fields.cartId,
      sessionId: fields.sessionId,
      expected: fields.expected,
      actual: fields.actual,
    },
    'Amount mismatch between Briqpay and commercetools',
  )
}
