import { describe, expect, it } from '@jest/globals'
import { resolvePlannedAmountFromSession } from '../../../src/libs/briqpay/session-amounts'
import { MediumBriqpayResponse } from '../../../src/services/types/briqpay-payment.type'

const sessionWithOrder = (amountIncVat?: number, currency?: string): MediumBriqpayResponse => {
  const session: MediumBriqpayResponse = {
    sessionId: 'session-1',
    htmlSnippet: '',
    data: { order: { amountIncVat, amountExVat: 0, currency } },
  }

  return session
}

describe('resolvePlannedAmountFromSession', () => {
  const cartAmount = { centAmount: 99700, currencyCode: 'EUR', fractionDigits: 2 }

  // The DEV-3803 drift: buyer paid 399.00, cart grew to 997.00 before the Order was cut.
  // Planning the cart total would make the underpaid Order look fully paid.
  it('plans what Briqpay authorized when the cart has drifted', () => {
    expect(
      resolvePlannedAmountFromSession({
        context: 'webhook',
        cartId: 'cart-1',
        session: sessionWithOrder(39900, 'EUR'),
        cartAmount,
      }),
    ).toEqual({ centAmount: 39900, currencyCode: 'EUR', fractionDigits: 2 })
  })

  it('keeps the cart amount when the session matches', () => {
    expect(
      resolvePlannedAmountFromSession({
        context: 'webhook',
        cartId: 'cart-1',
        session: sessionWithOrder(99700, 'EUR'),
        cartAmount,
      }),
    ).toBe(cartAmount)
  })

  it.each([
    ['a different currency', sessionWithOrder(39900, 'SEK')],
    ['no amount at all', sessionWithOrder(undefined, 'EUR')],
  ])('keeps the cart amount when the session carries %s', (_case, session) => {
    expect(resolvePlannedAmountFromSession({ context: 'webhook', cartId: 'cart-1', session, cartAmount })).toBe(
      cartAmount,
    )
  })
})
