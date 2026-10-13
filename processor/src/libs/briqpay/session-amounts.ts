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

/**
 * The amount to plan on the CT Payment. The cart stays mutable while the buyer is away at a
 * redirect PSP, and Checkout builds the Order from the live cart - so planning the cart amount
 * makes an Order that was only partly paid look fully paid. Plan what Briqpay actually
 * authorized instead: the Order still carries the drifted cart, but CT's own paid-in-full
 * checks now fail on it. The divergence is logged, never thrown - refusing here would leave a
 * paid Briqpay session with nothing in commercetools at all.
 *
 * Keeps the cart amount when the session carries no comparable amount or a different currency:
 * planning in a currency the cart does not use would be worse than planning the cart total.
 */
export const resolvePlannedAmountFromSession = <T extends { centAmount: number; currencyCode: string }>(fields: {
  context: string
  cartId: string
  session: MediumBriqpayResponse
  cartAmount: T
}): T => {
  const { context, cartId, session, cartAmount } = fields
  const sessionAmounts = readBriqpaySessionAmounts(session)

  if (sessionAmounts.amountIncVat === cartAmount.centAmount && sessionAmounts.currency === cartAmount.currencyCode) {
    return cartAmount
  }

  logAmountMismatch({
    context,
    cartId,
    sessionId: session.sessionId,
    expected: { centAmount: cartAmount.centAmount, currency: cartAmount.currencyCode },
    actual: sessionAmounts,
  })

  if (typeof sessionAmounts.amountIncVat !== 'number' || sessionAmounts.currency !== cartAmount.currencyCode) {
    return cartAmount
  }

  const authorized: T = { ...cartAmount, centAmount: sessionAmounts.amountIncVat }

  return authorized
}
