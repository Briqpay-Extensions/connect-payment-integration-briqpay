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
        fractionDigits: 2,
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
        fractionDigits: 2,
      }),
    ).toBe(cartAmount)
  })

  it.each([
    ['a different currency', sessionWithOrder(39900, 'SEK')],
    ['no amount at all', sessionWithOrder(undefined, 'EUR')],
  ])('keeps the cart amount when the session carries %s', (_case, session) => {
    expect(
      resolvePlannedAmountFromSession({ context: 'webhook', cartId: 'cart-1', session, cartAmount, fractionDigits: 2 }),
    ).toBe(cartAmount)
  })

  // Briqpay holds ISK x100, commercetools holds whole kronor.
  describe('a zero-decimal cart', () => {
    const iskCart = { centAmount: 10000, currencyCode: 'ISK', fractionDigits: 0 }

    it('keeps the cart amount when the session matches in Briqpay units', () => {
      expect(
        resolvePlannedAmountFromSession({
          context: 'webhook',
          cartId: 'cart-1',
          session: sessionWithOrder(1000000, 'ISK'),
          cartAmount: iskCart,
          fractionDigits: 0,
        }),
      ).toBe(iskCart)
    })

    it('plans the authorized amount back in commercetools units', () => {
      expect(
        resolvePlannedAmountFromSession({
          context: 'webhook',
          cartId: 'cart-1',
          session: sessionWithOrder(900000, 'ISK'),
          cartAmount: iskCart,
          fractionDigits: 0,
        }),
      ).toEqual({ centAmount: 9000, currencyCode: 'ISK', fractionDigits: 0 })
    })
  })
})
